/* M3 music — takes store: sidecars, listing, cross-process lock, atomic JSON.
 *
 * Pure Node stdlib on purpose (no electron require): the same module is
 * require()'d by the in-app main process and runs standalone, so tests can
 * import it in a bare `node --test` without an Electron runtime.
 *
 * Why: the Takes list used to hold only the current session — a restart
 * wiped it, and nothing recorded how a take was made (caption, seed, models,
 * reference). Each take now gets a `<name>.json` sidecar written next to its
 * wav/mp3, and `listTakes` rebuilds the list from the output folder. The
 * lock file keeps two Music Lab processes (in-app window and the standalone
 * app share ~/.config/music-lab) from sending one Pocket two generations.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ---------- sidecars ---------- */
// What was written for one take, next to the audio:
// { version, createdAt, caption, lyrics, seconds, seed, composer, writer,
//   reference, elapsedSec, files: { wav, mp3 } }
// reference is reduced to the file NAME (a path would outlive the references
// folder being moved); missing fields come out as null.
function sidecarFor(meta) {
  const m = meta || {};
  return {
    version: 1,
    createdAt: m.createdAt || new Date().toISOString(),
    caption: typeof m.caption === 'string' ? m.caption : null,
    lyrics: typeof m.lyrics === 'string' ? m.lyrics : null,
    seconds: typeof m.seconds === 'number' ? m.seconds : null,
    seed: typeof m.seed === 'number' ? m.seed : null,
    composer: typeof m.composer === 'string' ? m.composer : null,
    writer: typeof m.writer === 'string' ? m.writer : null,
    reference: m.reference ? path.basename(String(m.reference)) : null,
    elapsedSec: typeof m.elapsedSec === 'number' ? m.elapsedSec : null,
    files: {
      wav: m.wav ? path.basename(String(m.wav)) : null,
      mp3: m.mp3 ? path.basename(String(m.mp3)) : null,
    },
  };
}

/* ---------- listing ---------- */
// Newest first, at most `limit` entries. Each entry:
// { wav: absPath|null, mp3: absPath|null, meta: sidecar|null }
// Pairs .wav/.mp3 by basename (older takes predate sidecars and still list);
// a sidecar whose JSON is unreadable degrades to meta:null, never throws.
function listTakes(dir, limit = 50) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; } // missing dir = no takes yet
  // pair by the extension-less basename: t.wav + t.mp3 -> one take
  const base = n => n.replace(/\.(wav|mp3)$/i, '');
  const wav = new Map(), mp3 = new Map(), json = new Map();
  const mtime = new Map();
  for (const n of names) {
    if (n.endsWith('.tmp')) continue; // atomic-write residue, not a take file
    const st = (() => { try { return fs.statSync(path.join(dir, n)); } catch { return null; } })();
    if (!st || !st.isFile()) continue;
    mtime.set(n, st.mtimeMs);
    if (/\.wav$/i.test(n)) wav.set(base(n), path.join(dir, n));
    else if (/\.mp3$/i.test(n)) mp3.set(base(n), path.join(dir, n));
    else if (n.endsWith('.json')) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        if (o && typeof o === 'object' && !Array.isArray(o)) json.set(n, o);
      } catch { /* meta stays null for this take */ }
    }
  }
  const keys = new Set([...wav.keys(), ...mp3.keys()]);
  const takes = [...keys].map(k => ({
    wav: wav.get(k) || null,
    mp3: mp3.get(k) || null,
    meta: json.get(k + '.json') || null,
  }));
  // newest first: the sidecar's createdAt when present, else the newest file
  // mtime of the pair (a legacy take has no sidecar to trust)
  const rank = t => t.meta && Date.parse(t.meta.createdAt)
    || Math.max(t.wav && mtime.get(path.basename(t.wav)) || 0,
                t.mp3 && mtime.get(path.basename(t.mp3)) || 0) || 0;
  return takes.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
}

/* ---------- cross-process lock ---------- */
// The in-app window and the standalone app are two processes sharing one
// ~/.config/music-lab: a lock file (exclusive create, 'wx') keeps only one
// of them talking to the Pocket at a time.
const STALE_MAX_MS = 30 * 60 * 1000; // default ceiling; the caller passes its own timeout

// exists? -> { pid, startedAt, host } | null (unreadable counts as none)
function readLock(lockPath) {
  try {
    const o = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return (o && typeof o === 'object') ? { pid: o.pid, startedAt: o.startedAt, host: o.host } : null;
  } catch { return null; }
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // alive but not signalable by us
}

// -> { acquired, holder } (holder = the lock we found, null when we took it)
// Stale = the pid is gone, the startedAt is unparseable/missing, or the age
// exceeds maxAgeMs; a stale lock is replaced (unlink, then one 'wx' retry).
// 'wx' keeps the replace-then-acquire race safe: only one process can win.
// Creates the parent dir: a fresh profile has no config dir yet.
function acquireLock(lockPath, info = {}, maxAgeMs = STALE_MAX_MS) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const want = {
    pid: info.pid || process.pid,
    startedAt: info.startedAt || new Date().toISOString(),
    host: info.host || os.hostname(),
  };
  const write = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify(want, null, 2) + '\n');
    fs.closeSync(fd);
  };
  try { write(); return { acquired: true, holder: null }; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readLock(lockPath);
    if (holder) {
      const stale = holder.pid === want.pid || // our own leaked lock: ours to reclaim
        !pidAlive(holder.pid) ||
        !Date.parse(holder.startedAt) ||
        Date.now() - Date.parse(holder.startedAt) > maxAgeMs;
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch { /* gone anyway */ }
        try { write(); return { acquired: true, holder: null }; }
        catch { /* lost the race: someone else took it */ }
      }
    }
    return { acquired: false, holder: holder || { pid: null, startedAt: null, host: null } };
  }
}

// Release only our own lock (same pid): a stale lock left by a dead process
// is cleaned on the next acquire, never by a stranger. -> did we release?
function releaseLock(lockPath) {
  const h = readLock(lockPath);
  if (!h || h.pid !== process.pid) return false;
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

// What status should report: the live holder's pid, or null for none / ours /
// stale (dead pid, unparseable startedAt, over-age). A stale lock is
// reclaimed on the next acquire, so reporting it would block Generate for
// nothing after its owner crashed.
function validHolder(lockPath, maxAgeMs = STALE_MAX_MS) {
  const h = readLock(lockPath);
  if (!h || h.pid === process.pid) return null;
  if (!pidAlive(h.pid)) return null;
  const t = Date.parse(h.startedAt);
  return (!t || Date.now() - t > maxAgeMs) ? null : h.pid;
}

/* ---------- atomic write ---------- */
// tmp file + rename in the same directory: a crash mid-write leaves a
// .tmp (skipped by listTakes), never a truncated config/sidecar.
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw e; }
  return p;
}

module.exports = { sidecarFor, listTakes, readLock, acquireLock, releaseLock, validHolder, writeJsonAtomic };
