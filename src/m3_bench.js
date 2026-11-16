/* M3 — capability-aware benchmark. One bench per model *type*:
 *  - chat (supports_chat): streamed /v1/chat/completions → TTFT, tok/s decode
 *  - decision (capability systemone / type *classification*): /v1/systemone,
 *    one forward pass with typed questions (noul/choice/score) → latency, prefill tok/s
 *  - embedding: /v1/embeddings → latency, prefill tok/s
 * Contract for systemone verified live on the device and against
 * tiiny-control-panel tiinyui/decide.py (POST {model,state,questions} → {answers,usage}). */
'use strict';
const { BASE, jget, jpost } = require('./m3_device');

const BENCH_PROMPT = 'Write 4 lines in English about why fish do not talk.';
const BENCH_MAX = 256;
const BENCH_STATE = 'The backup service stopped running last night. The log shows "connection refused" '
  + 'when it tries to reach the gateway. Users have been unable to download files for an hour.';
const BENCH_QUESTIONS = {
  sev: { type: 'score', instructions: 'How severe is this incident?', criteria: ['none', 'low', 'medium', 'high', 'critical'] },
  cat: { type: 'choice', instructions: 'Which category best describes the problem?',
    criteria: { network: 'connection or port', disk: 'disk space or io', auth: 'credentials or permissions', other: 'other' } },
  blocked: { type: 'noul', instructions: 'Does it require immediate human intervention?' },
};

async function benchChat(model) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${require('./m3_device').authKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: BENCH_PROMPT }],
      stream: true, max_tokens: BENCH_MAX, temperature: 0 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  let first = null, last = t0, usage = null, text = '', buf = '';
  for await (const ch of r.body) {
    buf += Buffer.from(ch).toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const d = JSON.parse(payload);
        if (d.usage) usage = d.usage;
        const tok = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
        if (tok) { if (first === null) first = Date.now(); last = Date.now(); text += tok; }
      } catch { /* keep-alive */ }
    }
  }
  const total = last - t0;
  const dec = (first !== null && last > first) ? last - first : total;
  const comp = (usage && usage.completion_tokens) || Math.max(1, Math.round(text.length / 4));
  return { model, kind: 'chat', ttft_ms: first ? first - t0 : null, total_ms: total,
    tok_per_s: dec > 0 ? Math.round(comp * 1000 / dec) : 0,
    summary: `${comp} tok · ${text.length} char` };
}

/* Answer shapes from the device (contract: tiiny-control-panel decide.py normalize()):
 *  noul → {noul: p} | {probability: p};  choice/score → {probabilities: {label|idx: p}} or list. */
function answerBrief(qspec, a) {
  if (!a || typeof a !== 'object') return null;
  if (qspec.type === 'noul') {
    const p = a.noul != null ? Number(a.noul) : (a.probability != null ? Number(a.probability) : null);
    if (p == null || !isFinite(p)) return null;
    return p >= 0.5 ? `yes ${Math.round(p * 100)}%` : `no ${Math.round((1 - p) * 100)}%`;
  }
  let raw = a.probabilities;
  if (Array.isArray(raw)) { const m = {}; raw.forEach((v, i) => { m[i] = v; }); raw = m; }
  if (!raw || typeof raw !== 'object') return null;
  const labels = qspec.type === 'choice' ? Object.keys(qspec.criteria) : qspec.criteria;
  let best = null, bp = -1;
  for (const [k, v] of Object.entries(raw)) {
    const p = Number(v);
    if (!isFinite(p) || p <= bp) continue;
    let lab = k;
    if (/^\d+$/.test(k) && !(qspec.type === 'choice' && qspec.criteria[k] !== undefined)) lab = labels[Number(k)] ?? k;
    bp = p; best = lab;
  }
  return best == null ? null : `${best} ${Math.round(bp * 100)}%`;
}

async function benchSystemone(model) {
  const t0 = Date.now();
  const d = await jpost(`${BASE}/v1/systemone`, { model, state: BENCH_STATE, questions: BENCH_QUESTIONS });
  const total = Date.now() - t0;
  const answers = d.answers || {};
  const pt = d.usage && (d.usage.prompt_tokens || d.usage.total_tokens);
  const brief = Object.entries(BENCH_QUESTIONS)
    .map(([id, q]) => { const b = answerBrief(q, answers[id]); return b ? `${id}=${b}` : null; })
    .filter(Boolean).join(' · ');
  return { model, kind: 'decision', ttft_ms: null, total_ms: total,
    tok_per_s: pt ? Math.round(pt * 1000 / total) : null,
    summary: brief || `${Object.keys(answers).length} answers (unrecognized format)` };
}

async function benchEmbedding(model) {
  const t0 = Date.now();
  const d = await jpost(`${BASE}/v1/embeddings`, { model, input: BENCH_STATE });
  const total = Date.now() - t0;
  const pt = d.usage && d.usage.prompt_tokens;
  const dim = d.data && d.data[0] && d.data[0].embedding ? d.data[0].embedding.length : null;
  return { model, kind: 'embedding', ttft_ms: null, total_ms: total,
    tok_per_s: pt ? Math.round(pt * 1000 / total) : null,
    summary: dim ? `${dim} dim` : 'ok' };
}

async function capabilitiesOf(model) {
  try {
    const m = await jget(`${BASE}/v1/models`);
    const e = (m.data || []).find(x => x.id === model || (x.aliases || []).includes(model));
    return { caps: (e && e.capabilities) || [], type: (e && e.type) || '', chat: !!(e && e.supports_chat) };
  } catch { return { caps: [], type: '', chat: true }; }
}

async function runBenchmark(model) {
  const { caps, type, chat } = await capabilitiesOf(model);
  if (caps.includes('systemone') || /classif/i.test(type)) return benchSystemone(model);
  if (caps.includes('embedding')) return benchEmbedding(model);
  if (chat || caps.includes('main')) return benchChat(model);
  return benchChat(model); // unknown: chat is the honest default, errors surface as-is
}

module.exports = { runBenchmark };
