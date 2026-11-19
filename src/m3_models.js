/* M3 — shared model-load helpers (no Electron; used by the care engine and
 * reusable by any window). Reuses the load sequence the 18/11 writer analysis
 * and the Music Lab ensure_loaded ran against the Pocket:
 *   POST /api/v1/models/{id}/start, poll /v1/models, progress + failure from
 *   GET /api/v1/models/{id}/get_progress.
 *
 * Device base URL and auth come from m3_device (env TIINY_BASE override lets
 * tests point at the fake device; the real device names are the fallback).
 */
'use strict';
const { BASE, jget, jpost } = require('./m3_device');

// Model ids contain a '/' (owner/name): percent-encode each segment, keep the
// separator (same quoting as the tested callers).
const mpath = (id) => String(id).split('/').map(encodeURIComponent).join('/');

const shortName = (id) => String(id || '?').split('/').pop();

// The ids currently in memory (p8800-style list).
const runningIds = async () =>
  new Set(((await jget(`${BASE}/v1/models`)).data || []).map(x => x.id));

// What loading `id` would do: fits as is, or which in-memory models the device
// would evict to make room. The real device answers model_id/npu_required/
// npu_available; the fake answers unload_candidates/required_npu/available_npu
// + fits — both shapes are normalised here.
async function fitPlan(id) {
  const u = await jget(`${BASE}/api/v1/models/${mpath(id)}/unload_candidate`);
  const evicts = u.unload_candidates || u.model_id || [];
  return {
    id,
    fits: typeof u.fits === 'boolean' ? u.fits : evicts.length === 0,
    evicts,
    npuRequired: u.npu_required ?? u.required_npu ?? null,
    npuAvailable: u.npu_available ?? u.available_npu ?? null,
  };
}

// Load `id` into memory and wait until it serves requests.
// onProgress(progress 0..100 | null) fires while loading (null = still
// loading, no number yet). Throws when the device refuses (not installed,
// NPU budget full) or when the load does not finish within timeoutMs.
async function ensureLoaded(id, onProgress, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15 * 60 * 1000; // a cold big model can take minutes
  const pollMs = opts.pollMs || 1500;
  if (!id) throw new Error('no model id');
  if ((await runningIds()).has(id)) return; // already in memory
  await jpost(`${BASE}/api/v1/models/${mpath(id)}/start`, {}, 180000);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, pollMs));
    if ((await runningIds()).has(id)) return;
    const g = await jget(`${BASE}/api/v1/models/${mpath(id)}/get_progress`, 20000).catch(() => ({}));
    const st = String(g.status || '');
    if (/fail|error/i.test(st)) throw new Error(`the Pocket could not load ${shortName(id)}: ${st}`);
    if (onProgress) onProgress(typeof g.progress === 'number' && /load/i.test(st) ? g.progress : null);
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`${shortName(id)} did not load in ${Math.round(timeoutMs / 60000)} min`);
  }
}

// Unload `id` from memory (POST …/stop).
const unload = (id) => jpost(`${BASE}/api/v1/models/${mpath(id)}/stop`, {}, 60000);

module.exports = { mpath, shortName, runningIds, fitPlan, ensureLoaded, unload };
