/* M3 — cross-process engine lock (pure Node, no Electron).
 *
 * The care engine (m3_care.js) must run in exactly ONE process at a time:
 * both the in-app TiinyOS window and the standalone Device window talk to it,
 * and only one of them may own the poller. This helper serialises that with a
 * single lock file.
 *
 * Lock file = JSON { pid, startedAt, host, tool }. Ownership is by pid, so
 * "release only by owner" = only the process whose pid is recorded may remove
 * it; any other process gets a polite { ok:false, holder } instead of deleting
 * someone else's lock.
 *
 * Staleness rules (so a crash never wedges the engine):
 *   * a lock whose pid no longer exists is stale;
 *   * a lock older than `staleMs` is stale (upper bound on how long a live
 *     holder can block, e.g. a stuck poller that never released);
 *   * an UNREADABLE lock (non-JSON / truncated mid-write) is stale only once
 *     it is older than 5 s, so a lock being written right now is never clobbered.
 *
 * The file is created with O_EXCL (openSync 'wx') so two racers cannot both
 * write; if a stale lock is removed, the loser retries once.
 *
 * Default path: ~/.config/tiinyos-linux/engine.lock (same config dir the
 * engine uses for care.json — see docs/design/device-contract.md).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'tiinyos-linux', 'engine.lock');
// an unreadable lock is only clobbered once it is older than this
const UNREADABLE_STALE_MS = 5000;

/* Is a given pid running? kill(pid,0) sends no signal; EPERM means "exists but
 * not ours", ESRCH means "gone". */
function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/* Parse the lock file. Distinguishes "no file", "unreadable" (exists but not
 * valid JSON) and "ok" (a holder object). */
function readHolder(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { none: true } : { unreadable: true, mtimeMs: mtime(p) }; }
  try {
    const h = JSON.parse(raw);
    return (h && typeof h === 'object') ? { ok: true, holder: h } : { unreadable: true, mtimeMs: mtime(p) };
  } catch { return { unreadable: true, mtimeMs: mtime(p) }; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return Date.now(); }
}

/* Is the lock at `p` stale (safe to take over)? Pure-ish: no side effects. */
function isStale(p, { staleMs = 0 } = {}) {
  const r = readHolder(p);
  if (r.none) return true;                 // no lock: nothing to be stale about
  const now = Date.now();
  if (r.unreadable) return (now - (r.mtimeMs || now)) > UNREADABLE_STALE_MS;
  const h = r.holder;
  if (h && typeof h.pid === 'number' && staleMs > 0 && h.startedAt) {
    if (now - h.startedAt > staleMs) return true;   // age bound
  }
  return !pidAlive(h ? h.pid : undefined);         // holder pid dead
}

function writeLock(p, holder) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'wx');            // O_EXCL: fail if it already exists
  try { fs.writeSync(fd, JSON.stringify(holder, null, 2) + '\n'); }
  finally { fs.closeSync(fd); }
}

/* Try to take the engine lock.
 * opts.staleMs: age bound (ms) that makes a live holder's lock stale. 0 = no
 *   age bound (a live holder always wins until it releases or dies).
 * opts.tool:  the tool acquiring (recorded in the lock, informational).
 * Returns { ok, holder, stale } — `stale` true when we took over a stale lock.
 * A re-acquire by the owning pid is idempotent and returns ok. */
function acquire(p, opts = {}) {
  p = p || DEFAULT_PATH;
  const { staleMs = 0, tool = '' } = opts;
  const holder = { pid: process.pid, startedAt: Date.now(), host: os.hostname(), tool };

  try { writeLock(p, holder); return { ok: true, holder, stale: false }; }
  catch (e) { if (e.code !== 'EEXIST') throw e; }

  // already exists: is it ours (re-acquire), stale (take over), or someone else's?
  const r = readHolder(p);
  if (r.ok && r.holder && r.holder.pid === process.pid) return { ok: true, holder: r.holder, stale: false };

  if (isStale(p, { staleMs })) {
    try { fs.unlinkSync(p); } catch {}
    try { writeLock(p, holder); return { ok: true, holder, stale: true }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    // lost the race to a third writer — fall through and report the current holder
  }
  const r2 = readHolder(p);
  return { ok: false, holder: r2.holder || null, stale: false };
}

/* Release the lock. Only the owning pid may remove it; anyone else gets
 * { ok:false, holder }. Returns { ok, holder }. */
function release(p) {
  p = p || DEFAULT_PATH;
  const r = readHolder(p);
  if (!r.ok || !r.holder || r.holder.pid !== process.pid) return { ok: false, holder: r.holder || null };
  try { fs.unlinkSync(p); } catch {}
  return { ok: true, holder: r.holder };
}

/* Return the recorded holder, or null if there is no (readable) lock. Does not
 * judge staleness — that is acquire's job; this is for display/diagnostics. */
function holder(p) {
  p = p || DEFAULT_PATH;
  const r = readHolder(p);
  return r.ok ? r.holder : null;
}

module.exports = { acquire, release, holder, isStale, pidAlive, DEFAULT_PATH, UNREADABLE_STALE_MS };
