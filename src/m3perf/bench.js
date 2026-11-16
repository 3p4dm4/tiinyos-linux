/* M3 perf — benchmark runner: one row per run in the results table.
 * The result shape (kind/ttft/total/tok_s/summary) comes from main (m3_bench.js). */
window.M3 = window.M3 || {};
M3.bench = (function () {
  const { num } = M3.fmt;

  async function run(model, btn) {
    btn.disabled = true; btn.textContent = 'running…';
    const tb = document.querySelector('#t-bench tbody');
    try {
      const r = await window.m3.invoke('m3:benchmark', model);
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono"></td><td></td><td class="mono">' + num(r.ttft_ms) + '</td>'
        + '<td class="mono">' + r.total_ms + '</td><td class="mono">' + num(r.tok_per_s) + '</td>'
        + '<td class="note"></td>';
      tr.querySelector('td').textContent = r.model;
      tr.children[1].textContent = r.kind || 'chat';
      tr.querySelector('td:last-child').textContent = r.summary || '';
      tb.prepend(tr);
    } catch (e) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono"></td><td colspan="5" class="note err"></td>';
      tr.querySelector('td').textContent = model;
      tr.querySelector('td:last-child').textContent = String(e.message || e);
      tb.prepend(tr);
    } finally {
      while (tb.rows.length > 9) tb.deleteRow(tb.rows.length - 1);
      btn.disabled = false; btn.textContent = 'Benchmark';
    }
  }
  return { run };
})();
