// Smart clip planning: every clip starts where a thought starts and ends where it is finished.
// With a Groq key, an LLM reads the transcript and chooses sections (or best moments) + titles.
// Without one, sentence boundaries are scored with pauses, discourse cues and topic shifts
// (multilingual sentence embeddings), and dynamic programming picks the best cuts.
import { groqJSON } from './groq.js?v=9';

const END = /[.?!।॥]["'”’)]?$/;
const QEND = /\?["'”’)]?$/;
const OPENERS = /^(now|next|so now|okay|ok|alright|first(ly)?|second(ly)?|third(ly)?|finally|lastly|another|the (first|second|third|next|last|biggest|real)|here'?s|let'?s|number \d|step \d|tip \d|अब|तो अब|पहला|पहली|दूसरा|दूसरी|तीसरा|तीसरी|आखिरी|चलिए|देखिए|ab |toh ab|pehla|doosra|dusra|teesra|chaliye)/i;
const CONTINUES = /^(and|but|because|which|that|or|so that|then|also|as well|और|लेकिन|क्योंकि|जो|कि|या|तो|फिर|भी|aur|lekin|kyunki|jo|ki|ya|phir)\b/i;
const LOWER = /^["'“‘(]?[a-z]/;   // Latin word starting lowercase = sentence continues
const DANGLING = /\b(and|but|because|the|a|an|of|to|for|with|my|your|is|are|was|और|लेकिन|क्योंकि|का|की|के|को|से|में|aur|lekin|ka|ki|ke|ko|se|mein)[,]?$/i;

// Group words into sentences (also split at long pauses and overly long runs).
export function sentences(words) {
  const out = []; let cur = [];
  const push = () => { if (!cur.length) return; out.push({ s: cur[0].s, e: cur[cur.length - 1].e, i0: cur[0].i, i1: cur[cur.length - 1].i, text: cur.map((w) => w.w).join(' ') }); cur = []; };
  words.forEach((w, i) => {
    cur.push({ ...w, i });
    const nx = words[i + 1];
    const gap = nx ? nx.s - w.e : 9;
    const cont = nx && LOWER.test(nx.w) && !END.test(w.w);
    if (END.test(w.w) || (gap > 0.9 && (!cont || gap > 2.2)) || (cur.length > 45 && gap > 0.25) || cur.length > 70) push();
  });
  push();
  return out;
}

const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
const avg = (vs) => { const o = new Float32Array(vs[0].length); vs.forEach((v) => v.forEach((x, i) => o[i] += x / vs.length)); let n = Math.hypot(...o) || 1; return o.map((x) => x / n); };

// Score of cutting between sentence j and j+1 (higher = better place to cut).
export function boundaryScores(S, emb) {
  const b = new Float32Array(Math.max(0, S.length - 1));
  for (let j = 0; j < S.length - 1; j++) {
    const a = S[j], n = S[j + 1], gap = n.s - a.e;
    let sc = Math.min(gap, 1.5) / 1.5 * 1.2;
    if (END.test(a.text)) sc += 0.8; else sc -= 0.6;
    if (QEND.test(a.text)) sc -= 1.6;                // a question needs its answer
    if (DANGLING.test(a.text)) sc -= 1.2;
    if (OPENERS.test(n.text.trim())) sc += 0.9;
    if (OPENERS.test(a.text.trim()) && a.text.split(' ').length <= 8) sc -= 1.5; // "Next, let's talk about money." introduces what follows
    if (CONTINUES.test(n.text.trim())) sc -= 0.9;
    if (LOWER.test(n.text.trim()) && !END.test(a.text)) sc -= 2.2;
    if (emb) {
      const L = avg(emb.slice(Math.max(0, j - 2), j + 1)), R = avg(emb.slice(j + 1, Math.min(S.length, j + 4)));
      sc += Math.max(0, Math.min(1, (0.85 - cos(L, R)) / 0.45)) * 1.6;   // topic shift
    }
    b[j] = sc;
  }
  return b;
}

const hook = (t) => (/\?/.test(t) ? 0.6 : 0) + (/\d/.test(t) ? 0.4 : 0) + (/\b(you|your|secret|mistake|never|always|why|how|biggest|आप|क्यों|कैसे|गलती|सबसे)\b/i.test(t) ? 0.5 : 0) + (OPENERS.test(t) ? 0.3 : 0);

// Full coverage: partition sentences into clips of [min,max] seconds maximising boundary quality.
export function planFull(S, b, min, max) {
  const n = S.length; if (!n) return [];
  const target = (min + max) / 2;
  const f = new Float64Array(n + 1).fill(-Infinity), from = new Int32Array(n + 1).fill(-1); f[0] = 0;
  for (let k = 1; k <= n; k++) {
    for (let j = k - 1; j >= 0; j--) {
      const dur = S[k - 1].e - S[j].s;
      if (dur > max * 1.5) break;
      if (f[j] === -Infinity) continue;
      let sc = (k < n ? b[k - 1] : 1.5) - Math.abs(dur - target) / target * 0.6;
      if (dur < min) sc -= k === n ? (dur < min * 0.4 ? 3 : 1.2) : 2.5 + (min - dur) / min * 4;
      if (dur > max) sc -= 2 + (dur - max) / max * 6;
      if (f[j] + sc > f[k]) { f[k] = f[j] + sc; from[k] = j; }
    }
    if (f[k] === -Infinity) { f[k] = f[k - 1] - 5; from[k] = k - 1; } // a single huge sentence
  }
  const cuts = []; for (let k = n; k > 0; k = from[k]) cuts.push([from[k], k - 1]);
  return cuts.reverse().map(([a, z]) => ({ a, z }));
}

// Best moments: self-contained segments with strong starts and clean endings, non-overlapping.
export function planBest(S, b, min, max, count) {
  const cands = [];
  for (let a = 0; a < S.length; a++) {
    const startQ = a === 0 ? 1 : b[a - 1];
    if (startQ < 0.4) continue;
    for (let z = a; z < S.length; z++) {
      const dur = S[z].e - S[a].s; if (dur > max) break; if (dur < min) continue;
      const endQ = z === S.length - 1 ? 1.5 : b[z];
      if (endQ < 0.6) continue;
      const words = S.slice(a, z + 1).reduce((x, s) => x + s.text.split(' ').length, 0);
      const pace = Math.min(1, words / dur / 3);
      cands.push({ a, z, score: startQ + endQ + hook(S[a].text) * 1.5 + pace });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const pick = [];
  for (const c of cands) {
    if (pick.length >= count) break;
    if (pick.some((p) => !(c.z < p.a || c.a > p.z))) continue;
    pick.push(c);
  }
  return pick.sort((x, y) => x.a - y.a);
}

// Turn sentence ranges into clip times; pad a little so first/last words aren't clipped.
export function toClips(S, plan, dur, full) {
  return plan.map((p, k) => {
    const prevEnd = p.a > 0 ? S[p.a - 1].e : 0, nextStart = p.z < S.length - 1 ? S[p.z + 1].s : dur;
    let s = full ? (k === 0 ? 0 : (prevEnd + S[p.a].s) / 2) : Math.max(prevEnd, S[p.a].s - 0.25);
    let e = full ? (k === plan.length - 1 ? dur : (S[p.z].e + nextStart) / 2) : Math.min(nextStart, S[p.z].e + 0.45);
    if (!full) { s = Math.max(0, Math.min(s, S[p.a].s - 0.05)); e = Math.min(dur, Math.max(e, S[p.z].e + 0.1)); }
    return { s, e, title: p.title || '', a: p.a, z: p.z };
  });
}

const isCleanCut = (S, b, j) => j < 0 || j >= S.length - 1 || (END.test(S[j].text) && !LOWER.test(S[j + 1].text.trim()) && b[j] > -0.5);
export function snapBoundaries(S, b, plan, min, max, full) {
  if (!plan.length || !b) return plan;
  const P = plan.map((p) => ({ ...p })), dur = (a, z) => S[z].e - S[a].s, R = 4;
  const better = (j0, ok) => {
    let best = j0, bs = isCleanCut(S, b, j0) ? b[j0] + 3 : -Infinity;
    for (let d = 1; d <= R; d++) for (const j of [j0 - d, j0 + d]) {
      if (j < 0 || j >= S.length - 1 || !ok(j)) continue;
      const sc = (isCleanCut(S, b, j) ? 3 : 0) + b[j] - d * 0.25;
      if (sc > bs) { bs = sc; best = j; }
    }
    return best;
  };
  if (full) {
    for (let k = 1; k < P.length; k++) {
      const L = P[k - 1], C = P[k], j0 = C.a - 1;
      if (isCleanCut(S, b, j0)) continue;
      const j = better(j0, (j) => j >= L.a && j < C.z && dur(L.a, j) >= min * 0.6 && dur(L.a, j) <= max * 1.3 && dur(j + 1, C.z) >= min * 0.6 && dur(j + 1, C.z) <= max * 1.3);
      L.z = j; C.a = j + 1;
    }
    return P;
  }
  const out = P.map((p) => {
    if (!isCleanCut(S, b, p.a - 1)) { const j = better(p.a - 1, (j) => j < p.z && dur(j + 1, p.z) >= min * 0.7 && dur(j + 1, p.z) <= max * 1.25); p.a = j + 1; }
    if (!isCleanCut(S, b, p.z)) p.z = better(p.z, (j) => j >= p.a && dur(p.a, j) >= min * 0.7 && dur(p.a, j) <= max * 1.25);
    return p;
  });
  return out.filter((p, i) => !out.slice(0, i).some((q) => !(p.z < q.a || p.a > q.z)));
}

/* ------------------------------------------------------------------ LLM planning (Groq) */
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export async function planWithAI(key, S, { mode, min, max, count, lang }, onStatus) {
  const WIN = 160; // sentences per request (keeps free-tier token limits happy)
  const lines = (a, z) => S.slice(a, z + 1).map((s, i) => `[${a + i}] (${fmt(s.s)}-${fmt(s.e)}, ${(s.e - s.s).toFixed(0)}s) ${s.text}`).join('\n');
  const sys = `You are an expert short-form video editor (YouTube Shorts / Instagram Reels). You receive a numbered transcript of a video, one sentence per line with timestamps. You decide where clips start and end. Rules:
- A clip must START where a new thought, point, story or question begins (never in the middle of an idea, never with a word like "and/but/because/और/लेकिन" continuing the previous point).
- A clip must END only after the thought is complete: the point is made, the question is answered, the list item is finished, the punchline lands. Never end on a cliffhanger mid-explanation.
- Clip duration = end time of last sentence minus start time of first sentence. Respect the requested range.
- Titles: short catchy hook titles (max 7 words) in the same language/script as the transcript${lang === 'hinglish' ? ' (Hinglish in Roman letters)' : ''}.
Answer ONLY with JSON.`;
  const out = [];
  if (mode === 'full') {
    let a = 0;
    while (a < S.length) {
      const z = Math.min(S.length - 1, a + WIN - 1), last = z === S.length - 1;
      onStatus?.(`AI is finding where each point starts and ends · ${fmt(S[a].s)}…`);
      const user = `Split sentences [${a}]..[${z}] into consecutive clips that together cover every sentence in order (no gaps, no overlaps). Each clip should be ${min}-${max} seconds long; going up to ${Math.round(max * 1.25)}s is OK only if needed to finish a thought.${last ? '' : ' The last clip in this range may be left unfinished: still include it, it will be redone.'}
Return {"clips":[{"start":first_sentence_number,"end":last_sentence_number,"title":"..."}]}.

${lines(a, z)}`;
      const j = await groqJSON(key, sys, user, (s) => onStatus?.(`Free-tier limit reached, continuing in ${s}s…`));
      let clips = sanitize(j.clips, a, z).sort((x, y) => x.a - y.a);
      // enforce contiguity
      const fixed = []; let cur = a;
      for (const c of clips) { if (c.z < cur) continue; fixed.push({ ...c, a: cur }); cur = c.z + 1; }
      if (cur <= z) { if (fixed.length) fixed[fixed.length - 1].z = z; else fixed.push({ a, z, title: '' }); }
      if (!last && fixed.length > 1) { fixed.pop(); }
      out.push(...fixed);
      a = out[out.length - 1].z + 1;
    }
  } else {
    const per = Math.max(1, Math.round(count * WIN / S.length));
    for (let a = 0; a < S.length; a += WIN) {
      const z = Math.min(S.length - 1, a + WIN - 1);
      onStatus?.(`AI is picking the best moments · ${fmt(S[a].s)}…`);
      const user = `From sentences [${a}]..[${z}], pick up to ${Math.max(per, 1) + 1} of the strongest self-contained moments for viral short clips: a hook at the start (surprising claim, question, story start, strong opinion), a complete payoff at the end, understandable without the rest of the video. Each ${min}-${max} seconds. No overlaps. Score each 1-10 for viral potential.
Return {"clips":[{"start":n,"end":n,"title":"...","score":n}]}.

${lines(a, z)}`;
      const j = await groqJSON(key, sys, user, (s) => onStatus?.(`Free-tier limit reached, continuing in ${s}s…`));
      out.push(...sanitize(j.clips, a, z));
    }
    out.sort((x, y) => (y.score || 0) - (x.score || 0));
    const pick = [];
    for (const c of out) { if (pick.length >= count) break; if (!pick.some((p) => !(c.z < p.a || c.a > p.z))) pick.push(c); }
    return pick.sort((x, y) => x.a - y.a);
  }
  return out;
}
function sanitize(clips, a, z) {
  return (Array.isArray(clips) ? clips : []).map((c) => ({ a: Math.max(a, Math.min(z, parseInt(c.start))), z: Math.max(a, Math.min(z, parseInt(c.end))), title: String(c.title || '').slice(0, 80), score: +c.score || 0 }))
    .filter((c) => Number.isFinite(c.a) && Number.isFinite(c.z) && c.z >= c.a);
}

// Split any clip that is still far too long at its best internal boundary; merge tiny leftovers.
export function enforceLengths(S, b, plan, min, max, full) {
  const res = [];
  const dur = (p) => S[p.z].e - S[p.a].s;
  const split = (p) => {
    if (dur(p) <= max * 1.3 || p.a === p.z) { res.push(p); return; }
    let best = -1, bs = -Infinity;
    for (let j = p.a; j < p.z; j++) {
      const l = S[j].e - S[p.a].s, r = S[p.z].e - S[j + 1].s;
      if (l < min * 0.8 || r < min * 0.8) continue;
      const sc = b[j] - Math.abs(l - r) / (l + r);
      if (sc > bs) { bs = sc; best = j; }
    }
    if (best < 0) { res.push(p); return; }
    split({ a: p.a, z: best, title: p.title }); split({ a: best + 1, z: p.z, title: '' });
  };
  plan.forEach(split);
  if (full) for (let i = res.length - 1; i > 0; i--) if (dur(res[i]) < min * 0.45) { res[i - 1].z = res[i].z; res.splice(i, 1); }
  return res;
}

/* ------------------------------------------------------------------ AI subtitle cleanup */
// Fix misheard words (and optionally romanise Hindi to Hinglish) while keeping word timings.
export async function fixWords(key, words, lang, onStatus) {
  const S = sentences(words);
  const BATCH = 60;
  const out = words.map((w) => ({ ...w }));
  const sys = `You fix speech-to-text subtitle errors. You get sentences as JSON arrays of words. Correct misheard or misspelled words using context (e.g. "pashion"→"passion", wrong homophones, broken brand/finance terms like SIP, mutual fund, Sensex, Nifty). ${lang === 'hinglish' ? 'Also convert every Hindi word written in Devanagari into natural Roman Hinglish spelling (e.g. "पैसा"→"paisa", "क्योंकि"→"kyunki"); keep English words in English.' : 'Keep the original language and script.'} Do not translate, summarise, add or remove content. Keep EXACTLY the same number of words in each sentence, in the same order (one output word per input word). Answer ONLY with JSON {"s":[[words of sentence 0],[words of sentence 1],...]}.`;
  for (let k = 0; k < S.length; k += BATCH) {
    const part = S.slice(k, k + BATCH);
    onStatus?.(`AI is fixing subtitle spelling · ${Math.round(k / S.length * 100)}%`);
    const arr = part.map((s) => words.slice(s.i0, s.i1 + 1).map((w) => w.w));
    let j;
    try { j = await groqJSON(key, sys, JSON.stringify({ s: arr }), (s) => onStatus?.(`Free-tier limit reached, continuing in ${s}s…`)); }
    catch (e) { console.warn('cleanup batch failed', e); continue; }
    (j.s || []).forEach((ws, si) => {
      const sent = part[si]; if (!sent || !Array.isArray(ws)) return;
      const orig = words.slice(sent.i0, sent.i1 + 1);
      ws = ws.map((x) => String(x).trim()).filter(Boolean);
      if (!ws.length) return;
      if (ws.length === orig.length) ws.forEach((w, i) => out[sent.i0 + i].w = w);
      else if (Math.abs(ws.length - orig.length) <= Math.max(2, orig.length * 0.25)) {
        // re-time proportionally inside the sentence
        const s0 = orig[0].s, e0 = orig[orig.length - 1].e, tot = ws.reduce((a, x) => a + x.length + 1, 0); let t = s0;
        const re = ws.map((w) => { const d = (e0 - s0) * (w.length + 1) / tot, o = { w, s: t, e: t + d }; t += d; return o; });
        for (let i = sent.i0; i <= sent.i1; i++) out[i] = null;
        out[sent.i0] = re;
      }
    });
  }
  return out.flat().filter(Boolean);
}
