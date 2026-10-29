// ClipKaro "Custom Trim" mode: pick exact time ranges from one long video and export each as a
// ready-to-post 1080x1920 Short with burned-in, keyword-highlighted captions and an optional hook.
// The source file is never loaded into memory: Mediabunny reads only the bytes it needs (BlobSource),
// and the preview <video> streams from a blob URL.
import {
  Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat, QUALITY_HIGH,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/+esm';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const W = 1080, H = 1920;
const FONT = 'Poppins, "Noto Sans Devanagari", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", Arial, sans-serif';

/* ------------------------------------------------------------------ time helpers */
export function parseTime(str) {
  const s = String(str || '').trim(); if (!s) return NaN;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  const p = s.split(':').map(Number);
  if (p.slice(1).some((x) => x >= 60)) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}
export function fmtTime(t, ms) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  const base = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  return ms ? base + '.' + String(Math.floor((t % 1) * 10)) : base;
}
export const clipName = (s, e) => `clip_${fmtTime(s).replace(/:/g, '-')}_${fmtTime(e).replace(/:/g, '-')}.mp4`;

/* ------------------------------------------------------------------ captions */
// Remove words that were transcribed twice where two transcription pieces meet (same text,
// overlapping time) and any word fully stacked inside the previous one.
export function dedupeWords(words) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}$%]/gu, '');
  const out = [];
  for (const w of [...words].sort((a, b) => a.s - b.s)) {
    if (!w.w.trim()) continue;
    const q = out[out.length - 1];
    // Whisper sometimes splits numbers: "2" + ",400" → "2,400"; "$1" + ".5" → "$1.5"
    if (q && /\d$/.test(q.w) && /^[,.]\d/.test(w.w.trim()) && w.s - q.e < 0.6) { q.w += w.w.trim(); q.e = Math.max(q.e, w.e); continue; }
    const n = norm(w.w);
    const recent = out.slice(-8);
    if (recent.some((k) => norm(k.w) === n && (w.s < k.e - 0.05 || Math.abs(w.s - k.s) < 0.25))) continue;
    const p = out[out.length - 1];
    if (p && w.e <= p.e + 0.02 && w.s < p.e - 0.05) continue; // fully stacked on the previous word
    const x = { ...w };
    if (p && x.s < p.e) x.s = p.e;
    if (x.e <= x.s) x.e = x.s + 0.08;
    out.push(x);
  }
  return out;
}

// 1–2 short lines per caption: up to 6 words / ~28 letters, breaking at sentence ends and pauses.
export function buildTrimCaptions(words, s, e) {
  const ws = words.filter((w) => w.e > s + 0.05 && w.s < e - 0.05);
  const caps = []; let cur = [];
  const push = () => { if (cur.length) caps.push({ start: cur[0].s, end: cur[cur.length - 1].e, words: cur }); cur = []; };
  ws.forEach((w, i) => {
    const nx = ws[i + 1];
    cur.push({ w: w.w, s: w.s, e: w.e });
    const chars = cur.reduce((a, x) => a + x.w.length, 0);
    const keepNext = nx && (/\d$/.test(w.w) || MULT.test(w.w)) && MULT.test(nx.w) && nx.s - w.e < 0.6 && cur.length < 9; // never split "$1 | million"
    if (!keepNext && (cur.length >= 6 || chars >= 28 || /[.?!]$/.test(w.w) || (/[,;:]$/.test(w.w) && cur.length >= 3) || !nx || nx.s - w.e > 0.6)) push();
  });
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i], n = caps[i + 1];
    c.end = n && n.start - c.end < 0.5 ? n.start : Math.min(c.end + 0.3, n ? n.start : e);
    c.start = Math.max(c.start, s); c.end = Math.min(c.end, e);
  }
  return caps.filter((c) => c.end > c.start);
}

const MULT = /^(million|millions|billion|billions|thousand|thousands|hundred|lakh|lakhs|crore|crores|k|m|bn|percent|dollars?|rupees?)[.,!?]*$/i;
const normKey = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}$%]/gu, '');
function keySet(str) { return new Set(String(str || '').split(/[,\n]/).flatMap((x) => x.trim().split(/\s+/)).map(normKey).filter(Boolean)); }
export function isKeyword(word, prev, keys, auto) {
  if (keys.has(normKey(word))) return true;
  if (!auto) return false;
  if (/[\d$€£₹%]/.test(word)) return true;
  return MULT.test(word) && !!prev && (/\d/.test(prev) || MULT.test(prev) || /^(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a)$/i.test(prev.replace(/[^\w]/g, '')));
}

/* ------------------------------------------------------------------ drawing */
const bgC = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(27, 48) : null, bgX = bgC && bgC.getContext('2d');
// drawSrc(ctx, dx, dy, dw, dh) paints the source frame. nudge: -1 (show left edge) … 0 (center) … 1 (right edge)
function paintFrame(ctx, drawSrc, vw, vh, cfg) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (cfg.fit === 'blur') {
    const kb = Math.max(27 / vw, 48 / vh); drawSrc(bgX, (27 - vw * kb) / 2, (48 - vh * kb) / 2, vw * kb, vh * kb);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bgC, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, W, H);
    const k = Math.min(W / vw, H / vh); drawSrc(ctx, (W - vw * k) / 2, (H - vh * k) / 2, vw * k, vh * k);
    return;
  }
  const k = Math.max(W / vw, H / vh), dw = vw * k, dh = vh * k;
  const dx = (W - dw) / 2 * (1 + cfg.nudge), dy = (H - dh) / 2;
  drawSrc(ctx, dx, dy, dw, dh);
}

function wrap(ctx, tokens, maxW, space) {
  const lines = [[]]; let lw = 0;
  for (const t of tokens) { t.m = ctx.measureText(t.d).width; if (lw + t.m > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(t); lw += t.m + space; }
  return lines;
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

function drawCaption(ctx, cap, t, cfg, keys) {
  if (!cap || !cap.words.length) return;
  let fs = Math.round(W * 0.078);
  const pop = Math.min(1, Math.max(0, (t - cap.start) / 0.12)), scale = 0.9 + 0.1 * pop;
  const toks = cap.words.map((w, i) => ({ d: w.w, key: isKeyword(w.w, cap.words[i - 1]?.w, keys, cfg.autoHi) }));
  let lines, space;
  for (let k = 0; k < 6; k++) { // shrink until it fits on 2 lines
    ctx.font = `900 ${fs}px ${FONT}`; space = ctx.measureText(' ').width;
    lines = wrap(ctx, toks, W * 0.86, space);
    if (lines.length <= 2) break; fs = Math.round(fs * 0.9);
  }
  ctx.save();
  ctx.translate(W / 2, H * cfg.pos); ctx.scale(scale, scale);
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.textAlign = 'left';
  const lh = fs * 1.2, top = -(lines.length - 1) * lh / 2;
  lines.forEach((ln, li) => {
    const total = ln.reduce((a, w) => a + w.m, 0) + space * (ln.length - 1); let x = -total / 2; const y = top + li * lh;
    for (const w of ln) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = fs * 0.2; ctx.strokeText(w.d, x, y);
      ctx.fillStyle = w.key ? '#FFE11A' : '#FFFFFF'; ctx.fillText(w.d, x, y);
      x += w.m + space;
    }
  });
  ctx.restore();
}

function drawHook(ctx, text, rel, cfg) {
  if (!text || rel < 0 || rel > cfg.hookDur) return;
  const a = Math.min(1, rel / 0.15, (cfg.hookDur - rel) / 0.25);
  let fs = Math.round(W * 0.064), lines, space;
  const toks = text.trim().split(/\s+/).map((d) => ({ d }));
  for (let k = 0; k < 6; k++) {
    ctx.font = `900 ${fs}px ${FONT}`; space = ctx.measureText(' ').width;
    lines = wrap(ctx, toks, W * 0.8, space);
    if (lines.length <= 3) break; fs = Math.round(fs * 0.9);
  }
  const lh = fs * 1.22, padX = fs * 0.55, padY = fs * 0.4;
  const widths = lines.map((ln) => ln.reduce((x, w) => x + w.m, 0) + space * (ln.length - 1));
  const boxW = Math.max(...widths) + padX * 2, boxH = lines.length * lh + padY * 2, x0 = (W - boxW) / 2, y0 = H * 0.09;
  ctx.save(); ctx.globalAlpha = Math.max(0, a);
  ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24;
  roundRect(ctx, x0, y0, boxW, boxH, fs * 0.35); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#111111'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = `900 ${fs}px ${FONT}`;
  lines.forEach((ln, i) => ctx.fillText(ln.map((w) => w.d).join(' '), W / 2, y0 + padY + lh * (i + 0.5)));
  ctx.restore();
}

/* ------------------------------------------------------------------ state + UI */
const S = { file: null, url: '', dur: 0, vw: 0, vh: 0, ranges: [], seq: 0, active: null, busy: false };
const cfg = { fit: 'crop', nudge: 0, pos: 0.72, hookDur: 3, keys: '', autoHi: true };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('ck_trim') || '{}')); } catch {}
const saveCfg = () => { try { localStorage.setItem('ck_trim', JSON.stringify(cfg)); } catch {} };
let deps = null;
window.__clipkaroTrim = S; // handy for debugging in DevTools

export function initTrim(d) {
  deps = d;
  // mode tabs
  const setMode = (m) => {
    document.body.dataset.mode = m;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === m));
    try { localStorage.setItem('ck_mode', m); } catch {}
    if (m === 'trim') drawPreview();
  };
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => setMode(b.dataset.tab));
  let m0 = 'auto'; try { m0 = localStorage.getItem('ck_mode') || 'auto'; } catch {}
  if (location.hash === '#trim') m0 = 'trim';
  setMode(m0);

  // upload
  $('tDrop').onclick = () => $('tFile').click();
  $('tDrop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('tFile').click(); };
  ['dragenter', 'dragover'].forEach((ev) => $('tDrop').addEventListener(ev, (e) => { e.preventDefault(); $('tDrop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $('tDrop').addEventListener(ev, (e) => { e.preventDefault(); $('tDrop').classList.remove('over'); }));
  $('tDrop').addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadVideo(f); });
  $('tFile').onchange = (e) => { const f = e.target.files[0]; if (f) loadVideo(f); e.target.value = ''; };
  $('tChange').onclick = () => { if (!S.busy) $('tFile').click(); };

  // style controls
  document.querySelectorAll('.tseg').forEach((g) => {
    const k = g.dataset.k;
    g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(cfg[k]) === b.dataset.v));
    g.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; g.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); cfg[k] = b.dataset.v; saveCfg(); syncStyle(); };
  });
  $('tNudge').value = Math.round(cfg.nudge * 100); $('tNudge').oninput = () => { cfg.nudge = +$('tNudge').value / 100; saveCfg(); syncStyle(); };
  $('tPos').value = Math.round(cfg.pos * 100); $('tPos').oninput = () => { cfg.pos = +$('tPos').value / 100; saveCfg(); syncStyle(); };
  $('tHookDur').value = cfg.hookDur; $('tHookDur').oninput = () => { const v = +$('tHookDur').value; if (v > 0 && v <= 15) { cfg.hookDur = v; saveCfg(); markDirty(); drawPreview(); } };
  $('tKeys').value = cfg.keys; $('tKeys').oninput = () => { cfg.keys = $('tKeys').value; saveCfg(); markDirty(); drawPreview(); refreshCapLists(); };
  $('tAutoHi').checked = cfg.autoHi; $('tAutoHi').onchange = () => { cfg.autoHi = $('tAutoHi').checked; saveCfg(); markDirty(); drawPreview(); refreshCapLists(); };
  syncStyle();

  $('tAdd').onclick = () => addRange();
  $('tCapAll').onclick = () => runAll(false);
  $('tExportAll').onclick = () => runAll(true);

  const v = $('tVideo');
  let raf = 0;
  const loop = () => { drawPreview(); if (!v.paused) raf = requestAnimationFrame(loop); };
  v.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  ['seeked', 'loadeddata', 'canplay', 'pause', 'timeupdate'].forEach((ev) => v.addEventListener(ev, () => { if (v.paused) drawPreview(); }));
  v.addEventListener('timeupdate', () => { $('tNow').textContent = fmtTime(v.currentTime, true); });
}

function syncStyle() {
  $('tNudgeWrap').classList.toggle('dim', cfg.fit !== 'crop');
  $('tNudgeVal').textContent = cfg.nudge === 0 ? 'center' : (cfg.nudge < 0 ? `${Math.round(-cfg.nudge * 100)}% left` : `${Math.round(cfg.nudge * 100)}% right`);
  $('tPosVal').textContent = `${Math.round(cfg.pos * 100)}% from top`;
  markDirty(); drawPreview();
}
function markDirty() { S.ranges.forEach((r) => { if (r.blob) { r.dirty = true; updateResult(r); } }); }

async function loadVideo(f) {
  if (S.busy) return;
  if (!f.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name)) { alert('Please choose a video file.'); return; }
  if (S.url) URL.revokeObjectURL(S.url);
  S.ranges.forEach((r) => r.url && URL.revokeObjectURL(r.url));
  Object.assign(S, { file: f, url: URL.createObjectURL(f), ranges: [], dur: 0 });
  $('tMeta').textContent = 'Reading video…';
  $('tWork').classList.remove('hidden'); $('tDrop').classList.add('hidden'); $('trimClips').classList.remove('hidden');
  const v = $('tVideo'); v.src = S.url;
  try {
    const input = new Input({ source: new BlobSource(f), formats: ALL_FORMATS });
    S.dur = await input.computeDuration();
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('No video track found');
    S.vw = await vt.getDisplayWidth(); S.vh = await vt.getDisplayHeight();
    S.hasAudio = !!(await input.getPrimaryAudioTrack());
    if (!(await vt.canDecode())) throw new Error("This browser can't decode this video. Try Chrome/Edge or an H.264 MP4.");
    input.dispose?.();
    $('tMeta').textContent = `${f.name} · ${fmtTime(S.dur)} · ${S.vw}×${S.vh} · ${(f.size / 1e6).toFixed(0)} MB${S.hasAudio ? '' : ' · no audio'}`;
  } catch (e) { $('tMeta').textContent = '⚠ ' + (e.message || e); }
  $('tRanges').innerHTML = '';
  addRange();
}

function addRange(s = '', e = '') {
  const r = { id: ++S.seq, sStr: s, eStr: e, hook: '', words: null, caps: null, status: '', pct: 0 };
  S.ranges.push(r);
  const el = document.createElement('div'); el.className = 'rg'; el.id = 'rg' + r.id;
  el.innerHTML = `
    <div class="rgh"><b>Clip <span class="rn"></span></b><span class="small rlen"></span><button class="x" title="Remove">✕</button></div>
    <div class="rrow">
      <label class="tf">Start<input class="ts" inputmode="numeric" placeholder="33:07" value="${esc(s)}"></label><button class="btn ghost sm setS" title="Use the preview's current time">⏱ Set</button>
      <label class="tf">End<input class="te" inputmode="numeric" placeholder="34:14" value="${esc(e)}"></label><button class="btn ghost sm setE" title="Use the preview's current time">⏱ Set</button>
      <button class="btn ghost sm play">▶ Preview range</button>
    </div>
    <div class="small rmsg"></div>
    <label class="tf wide">Hook text <span class="muted">(optional, shown at the top for the first ${cfg.hookDur}s)</span><input class="th" placeholder="He paid Target $1,000,000 for a shelf 🤯"></label>
    <div class="row" style="margin-top:8px"><button class="btn ghost sm cap">📝 Write captions</button><button class="btn sm exp">⬇ Export clip</button><span class="small status rst"></span></div>
    <div class="bar hidden"><i></i></div>
    <div class="caps hidden"></div>
    <div class="rout"></div>`;
  $('tRanges').appendChild(el);
  const q = (c) => el.querySelector(c);
  const onTime = () => { r.sStr = q('.ts').value; r.eStr = q('.te').value; validate(r); if (r.words) { r.caps = null; renderCaps(r); } markRangeDirty(r); drawPreview(); };
  q('.ts').oninput = onTime; q('.te').oninput = onTime;
  q('.ts').onfocus = q('.te').onfocus = q('.th').onfocus = () => { S.active = r; drawPreview(); };
  q('.setS').onclick = () => { q('.ts').value = fmtTime($('tVideo').currentTime, true).replace(/\.0$/, ''); onTime(); S.active = r; };
  q('.setE').onclick = () => { q('.te').value = fmtTime($('tVideo').currentTime, true).replace(/\.0$/, ''); onTime(); S.active = r; };
  q('.play').onclick = () => { if (!validate(r)) return; const v = $('tVideo'); S.active = r; v.currentTime = r.s; v.play(); const stop = () => { if (v.currentTime >= r.e) { v.pause(); v.removeEventListener('timeupdate', stop); } }; v.addEventListener('timeupdate', stop); };
  q('.th').oninput = () => { r.hook = q('.th').value; markRangeDirty(r); drawPreview(); };
  q('.x').onclick = () => { if (S.busy) return; S.ranges = S.ranges.filter((x) => x !== r); el.remove(); if (r.url) URL.revokeObjectURL(r.url); renumber(); if (!S.ranges.length) addRange(); };
  q('.cap').onclick = () => withBusy(() => ensureCaptions(r, true));
  q('.exp').onclick = () => withBusy(() => exportRange(r));
  renumber(); validate(r);
  S.active = r;
}
function renumber() { S.ranges.forEach((r, i) => { const n = document.querySelector(`#rg${r.id} .rn`); if (n) n.textContent = i + 1; }); }
function markRangeDirty(r) { if (r.blob) { r.dirty = true; updateResult(r); } }

function validate(r) {
  const el = $('rg' + r.id); if (!el) return false;
  const s = parseTime(r.sStr), e = parseTime(r.eStr), msg = el.querySelector('.rmsg'), len = el.querySelector('.rlen');
  let ok = false, text = '', cls = 'warnTxt';
  if (!r.sStr && !r.eStr) text = 'Type a start and end time (HH:MM:SS or MM:SS), or play the video and press ⏱ Set.';
  else if (isNaN(s)) text = 'Start time is not valid. Use HH:MM:SS or MM:SS, like 33:07.';
  else if (isNaN(e)) text = 'End time is not valid. Use HH:MM:SS or MM:SS, like 34:14.';
  else if (e <= s) text = 'End must be after start.';
  else if (S.dur && e > S.dur + 0.05) text = `End is past the end of the video (${fmtTime(S.dur)}).`;
  else if (S.dur && s >= S.dur) text = `Start is past the end of the video (${fmtTime(S.dur)}).`;
  else { ok = true; if (e - s < 15) text = `⚠ Only ${(e - s).toFixed(1)}s — most clipping campaigns need at least 15 seconds.`; else if (e - s > 180) { text = 'Note: clips over 3 minutes are not allowed as YouTube Shorts.'; } else { text = ''; } }
  r.ok = ok; if (ok) { r.s = s; r.e = Math.min(e, S.dur || e); }
  msg.textContent = text; msg.className = 'small rmsg ' + (ok && !text ? '' : cls);
  len.textContent = ok ? `${fmtTime(r.s)} → ${fmtTime(r.e)} · ${(r.e - r.s).toFixed(1)}s` : '';
  el.querySelector('.exp').disabled = !ok; el.querySelector('.cap').disabled = !ok || !S.hasAudio;
  return ok;
}

function setStatus(r, text, pct) {
  const el = $('rg' + r.id); if (!el) return;
  el.querySelector('.rst').textContent = text || '';
  const bar = el.querySelector('.bar');
  if (pct == null) bar.classList.add('hidden'); else { bar.classList.remove('hidden'); bar.querySelector('i').style.width = Math.max(0, Math.min(100, pct)) + '%'; }
}

async function withBusy(fn) {
  if (S.busy) return; S.busy = true; document.body.classList.add('tbusy');
  try { await fn(); } finally { S.busy = false; document.body.classList.remove('tbusy'); }
}
async function runAll(exp) {
  await withBusy(async () => {
    for (const r of S.ranges) {
      if (!validate(r)) continue;
      try { if (exp) await exportRange(r); else await ensureCaptions(r, false); } catch (e) { console.error(e); }
    }
  });
}

/* ------------------------------------------------------------------ captions for one range */
async function ensureCaptions(r, force) {
  if (!validate(r)) return;
  if (!S.hasAudio) { r.words = []; r.caps = []; renderCaps(r); return; }
  const key = `${r.s}-${r.e}`;
  if (!force && r.words && r.wordsKey === key) { if (!r.caps) { r.caps = buildTrimCaptions(r.words, r.s, r.e); renderCaps(r); } return; }
  const a = Math.max(0, r.s - 1.5), b = Math.min(S.dur, r.e + 1.5); // small buffer so edge words are complete
  setStatus(r, 'Writing captions…', 0);
  try {
    const words = await deps.transcribeRange(S.file, a, b, (msg, pct) => setStatus(r, msg, pct));
    r.words = dedupeWords(words); r.wordsKey = key;
    r.caps = buildTrimCaptions(r.words, r.s, r.e);
    setStatus(r, `✓ ${r.caps.length} caption lines — check names and numbers below, then export.`);
    renderCaps(r); markRangeDirty(r); drawPreview();
  } catch (e) { setStatus(r, '⚠ Captions failed: ' + (e.message || e)); throw e; }
}

function renderCaps(r) {
  const box = document.querySelector(`#rg${r.id} .caps`); if (!box) return;
  if (r.words && !r.caps) r.caps = buildTrimCaptions(r.words, r.s, r.e);
  if (!r.caps) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const keys = keySet(cfg.keys);
  box.innerHTML = r.caps.length ? r.caps.map((c, i) => `<div class="capl"><span class="t">${fmtTime(c.start, true)}</span><input data-i="${i}" value="${esc(c.words.map((w) => w.w).join(' '))}"><span class="hl">${c.words.map((w, j) => isKeyword(w.w, c.words[j - 1]?.w, keys, cfg.autoHi) ? `<b>${esc(w.w)}</b>` : '').filter(Boolean).join(' ')}</span></div>`).join('')
    : '<div class="small muted">No speech found in this range.</div>';
  box.querySelectorAll('input').forEach((inp) => inp.onchange = () => { editCaption(r.caps[+inp.dataset.i], inp.value); renderCaps(r); markRangeDirty(r); drawPreview(); });
}
function refreshCapLists() { S.ranges.forEach((r) => r.caps && renderCaps(r)); }
function editCaption(c, text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) { c.words = []; return; }
  const s0 = c.words[0]?.s ?? c.start, e0 = c.words[c.words.length - 1]?.e ?? c.end, tot = words.reduce((a, w) => a + w.length + 1, 0); let t = s0;
  c.words = words.map((w) => { const d = (e0 - s0) * (w.length + 1) / tot, o = { w, s: t, e: t + d }; t += d; return o; });
}

/* ------------------------------------------------------------------ live preview */
function capAt(r, t) { return r && r.caps ? r.caps.find((c) => t >= c.start && t < c.end) : null; }
function drawPreview() {
  const cv = $('tPrev'); if (!cv || document.body.dataset.mode !== 'trim') return;
  const ctx = cv.getContext('2d'), v = $('tVideo'), k = cv.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (v.readyState >= 2 && v.videoWidth) paintFrame(ctx, (c, x, y, w, h) => c.drawImage(v, x, y, w, h), v.videoWidth, v.videoHeight, cfg);
  else { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); }
  const t = v.currentTime || 0;
  const r = S.ranges.find((x) => x.ok && t >= x.s && t < x.e) || S.active;
  const keys = keySet(cfg.keys);
  const cap = capAt(r, t) || (r && r.caps ? null : { start: t - 1, end: t + 1, words: 'Captions appear here, with $1,000,000 and 2,400 highlighted'.split(' ').slice(0, 6).map((w) => ({ w, s: 0, e: 0 })) });
  drawCaption(ctx, cap, t, cfg, keys);
  if (r && r.hook) drawHook(ctx, r.hook, r.ok && t >= r.s && t < r.e ? t - r.s : Math.min(1, cfg.hookDur / 2), cfg);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ------------------------------------------------------------------ export */
async function exportRange(r) {
  if (!validate(r)) return;
  if (!r.caps) await ensureCaptions(r, false);
  const keys = keySet(cfg.keys), c = { ...cfg }, caps = (r.caps || []).slice(), hook = r.hook;
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { alpha: false });
  try { await document.fonts.load(`900 80px Poppins`); } catch {}
  const input = new Input({ source: new BlobSource(S.file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let rel = null, idx = 0;
  const conv = await Conversion.init({
    input, output, trim: { start: r.s, end: r.e }, tags: {},
    video: {
      codec: 'avc', frameRate: 30, quality: QUALITY_HIGH, hardwareAcceleration: 'prefer-hardware',
      processedWidth: W, processedHeight: H, forceTranscode: true,
      process: (sample) => {
        if (rel === null) rel = r.s > 1 && sample.timestamp < r.s - 0.5; // timestamps may be clip-relative
        const t = rel ? r.s + sample.timestamp : sample.timestamp;
        paintFrame(ctx, (cx, x, y, w, h) => sample.draw(cx, x, y, w, h), sample.displayWidth, sample.displayHeight, c);
        while (idx < caps.length && caps[idx].end <= t) idx++;
        const cap = caps[idx] && caps[idx].start <= t ? caps[idx] : null;
        drawCaption(ctx, cap, t, c, keys);
        drawHook(ctx, hook, t - r.s, c);
        return cv;
      },
    },
    audio: { codec: 'aac', quality: QUALITY_HIGH },
  });
  if (!conv.isValid) { input.dispose?.(); throw new Error('This browser cannot encode H.264/AAC (' + conv.discardedTracks.map((d) => d.reason).join(', ') + '). Use Chrome or Edge.'); }
  const t0 = performance.now(), len = r.e - r.s;
  conv.onProgress = (p) => setStatus(r, `Exporting · ${Math.round(p * 100)}% · ${(p * len / Math.max(0.3, (performance.now() - t0) / 1000)).toFixed(1)}× real-time`, p * 100);
  setStatus(r, 'Exporting…', 0);
  try { await conv.execute(); } finally { input.dispose?.(); }
  if (r.url) URL.revokeObjectURL(r.url);
  r.blob = new Blob([output.target.buffer], { type: 'video/mp4' }); r.url = URL.createObjectURL(r.blob); r.name = clipName(r.s, r.e); r.dirty = false;
  setStatus(r, `✓ Exported in ${((performance.now() - t0) / 1000).toFixed(0)}s · ${(r.blob.size / 1e6).toFixed(1)} MB`);
  updateResult(r);
}
function updateResult(r) {
  const out = document.querySelector(`#rg${r.id} .rout`); if (!out) return;
  if (!r.blob) { out.innerHTML = ''; return; }
  if (!out.querySelector('video') || out.dataset.url !== r.url) {
    out.dataset.url = r.url;
    out.innerHTML = `<video src="${r.url}" controls playsinline preload="metadata"></video><div class="row"><a class="btn sm" href="${r.url}" download="${r.name}">⬇ Download ${esc(r.name)}</a><span class="small warnTxt rdirty"></span></div>`;
  }
  out.querySelector('.rdirty').textContent = r.dirty ? 'Settings changed since export — press Export clip again to update.' : '';
}
