/* M3 — device HTTP client (auth + JSON verbs). Single place that knows the
 * device base URL and where the auth key lives. Used by m3_bench/m3_performance. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/* Base URLs. Overridable via env TIINY_BASE so tests can point both at the fake
 * device (tests/fake_pocket.py) on localhost; when unset the real device names
 * are used and behaviour is unchanged. One URL serves both roles in the fake. */
const BASE = process.env.TIINY_BASE || 'http://api.tiiny';
const P8800 = process.env.TIINY_BASE || 'http://p8800.api.tiiny';

function authKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.local/tiiny/config.json'), 'utf8'));
    return (cfg.account && cfg.account.authKey) || '';
  } catch { return ''; }
}

function hdr(k, json) {
  return { ...(k ? { Authorization: 'Bearer ' + k } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function jget(url, timeoutMs = 8000) {
  const r = await fetch(url, { headers: hdr(authKey()), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function jpost(url, body, timeoutMs = 60000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: hdr(authKey(), true),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r.json();
}

module.exports = { BASE, P8800, authKey, jget, jpost };
