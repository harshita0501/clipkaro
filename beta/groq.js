// Optional cloud AI via the user's own free Groq API key (https://console.groq.com/keys).
// The key stays in this browser; requests go straight from the browser to Groq.
const API = 'https://api.groq.com/openai/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let modelsCache = null;
export async function groqModels(key) {
  if (modelsCache && modelsCache.key === key) return modelsCache.ids;
  const r = await fetch(API + '/models', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error(r.status === 401 ? 'Groq key is invalid' : 'Groq error ' + r.status);
  const ids = (await r.json()).data.map((m) => m.id);
  modelsCache = { key, ids };
  return ids;
}

async function call(key, path, init, label, onWait) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try { r = await fetch(API + path, { ...init, headers: { Authorization: 'Bearer ' + key, ...(init.headers || {}) } }); }
    catch (e) { if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; } throw new Error(label + ': network error'); }
    if (r.ok) return r.json();
    const body = await r.text();
    if (r.status === 429 || r.status >= 500) {
      // free tier rate limit: wait as told, then retry
      let wait = parseFloat(r.headers.get('retry-after') || '') * 1000;
      const m = body.match(/try again in ([\d.]+)(ms|s|m)/i);
      if (!wait && m) wait = parseFloat(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 'm' ? 60000 : 1000);
      wait = Math.min(Math.max(wait || 5000, 1000), 120000);
      onWait?.(Math.ceil(wait / 1000));
      await sleep(wait + 300);
      continue;
    }
    let msg = body; try { msg = JSON.parse(body).error.message; } catch {}
    const err = new Error(`${label}: ${msg}`); err.status = r.status; throw err;
  }
  throw new Error(label + ': Groq is rate-limiting, try again in a minute');
}

// 16-bit mono WAV from 16 kHz float PCM (small enough: ~1.9 MB per minute)
function wav(pcm) {
  const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([b], { type: 'audio/wav' });
}

const PROMPTS = {
  hi: 'नमस्ते दोस्तों, आज हम बात करेंगे पैसे, निवेश और बिज़नेस के बारे में।',
  hinglish: 'नमस्ते दोस्तों, आज हम बात करेंगे SIP, mutual fund, investment और business के बारे में।',
  en: 'Hello everyone, today we will talk about money, investing and business.',
};

// Transcribe one block of 16 kHz audio. Returns words with absolute times.
export async function groqTranscribe(key, pcm, offset, lang, onWait) {
  const fd = new FormData();
  fd.append('file', wav(pcm), 'audio.wav');
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  fd.append('temperature', '0');
  const l = lang === 'hinglish' ? 'hi' : lang;
  if (l && l !== 'auto') fd.append('language', l);
  if (PROMPTS[lang]) fd.append('prompt', PROMPTS[lang]);
  const j = await call(key, '/audio/transcriptions', { method: 'POST', body: fd }, 'Groq transcription', onWait);
  const words = (j.words || []).map((w) => ({ w: String(w.word).trim(), s: offset + w.start, e: offset + Math.max(w.end, w.start + 0.05) })).filter((w) => w.w);
  if (words.length || !j.segments) return words;
  // fallback: spread segment times over words
  const out = [];
  for (const sg of j.segments) {
    const ws = sg.text.trim().split(/\s+/).filter(Boolean); const tot = ws.reduce((a, x) => a + x.length + 1, 0); let t = sg.start;
    for (const x of ws) { const d = (sg.end - sg.start) * (x.length + 1) / tot; out.push({ w: x, s: offset + t, e: offset + t + d }); t += d; }
  }
  return out;
}

// Pick the best chat model this key can use.
export async function groqChatModel(key) {
  const ids = await groqModels(key);
  const pref = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
  return pref.find((p) => ids.includes(p)) || ids.find((x) => !/whisper|guard|tts|orpheus|playai|compound/i.test(x));
}

export async function groqJSON(key, system, user, onWait) {
  const model = await groqChatModel(key);
  if (!model) throw new Error('No Groq chat model available');
  const body = { model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';
  let j;
  try { j = await call(key, '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Groq AI', onWait); }
  catch (e) {
    if (e.status !== 400) throw e;
    delete body.response_format; delete body.reasoning_effort;
    j = await call(key, '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Groq AI', onWait);
  }
  const txt = j.choices?.[0]?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : txt);
}
