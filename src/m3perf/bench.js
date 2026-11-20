/* M3 Device — benchmark runner (renderer side).
 *
 * Runs the capability-aware benchmark through the existing `m3:benchmark` IPC
 * (main/m3_bench.js) and keeps a short in-session history so the Status tab can
 * show a "Benchmark runs" table and a per-model "Last benchmark" cell. History
 * is deliberately session-only (not persisted): a benchmark is a probe, not a
 * record.
 */
window.M3 = window.M3 || {};
M3.bench = (function () {
  var CAPS = { systemone: 'decision', embedding: 'embedding', main: 'chat' };

  // Which benchmark kind does a model support? null = not benchmarkable
  // (music, media, speech). chat / decision / embedding are the three kinds the
  // device answers with measurable latency/tokens (design §3 "Benchmark").
  function kindOf(m) {
    var caps = m.capabilities || [], t = m.type || '';
    if (caps.indexOf('systemone') >= 0 || /classif/i.test(t)) return 'decision';
    if (caps.indexOf('embedding') >= 0 || /embedding/i.test(t)) return 'embedding';
    if (m.supports_chat || caps.indexOf('main') >= 0 || /text generation|image-text/i.test(t)) return 'chat';
    return null;
  }

  var history = []; // newest first
  function push(r) {
    r.at = Date.now();
    history.unshift(r);
    while (history.length > 9) history.pop(); // "last 9"
    M3.bus.emit('bench');
  }
  function lastFor(id) {
    for (var i = 0; i < history.length; i++) if (history[i].model === id && history[i].ok) return history[i];
    return null;
  }

  // Run a benchmark. btn (optional) is the row's button: it shows a spinner and
  // stays disabled until the result lands (pending contract). Returns a Promise.
  function run(modelId, kind, btn) {
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
    return window.m3.invoke('m3:benchmark', modelId).then(function (r) {
      push({ model: r.model || modelId, kind: r.kind || kind || 'chat',
        ttft_ms: r.ttft_ms == null ? null : r.ttft_ms, total_ms: r.total_ms,
        tok_per_s: r.tok_per_s, summary: r.summary || '', ok: true });
      return r;
    }).catch(function (e) {
      push({ model: modelId, kind: kind || 'chat', error: String(e.message || e), ok: false });
      if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; }
      throw e;
    }).then(function (r) { if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; } return r; });
  }

  return { history: history, lastFor: lastFor, kindOf: kindOf, run: run };
})();
