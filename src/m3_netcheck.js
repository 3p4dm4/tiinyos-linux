/* M3 — Connection check: do the device names the TiinyOS app uses resolve to
 * the Pocket, and does each one answer?
 *
 * The app reaches the device only through fixed host names (*.api.tiiny); on
 * Linux they come from /etc/hosts (docs/network.md). A missing or stale line
 * shows up as a feature that silently does nothing, so this reads, for every
 * name: where it resolves (and whether /etc/hosts has it), and the HTTP status
 * of a plain GET / (no auth key is sent). Each name gets one verdict and one
 * remedy in plain words.
 *
 * No Electron here; lookup, probe and the hosts file are injectable so tests
 * run without a network. */
'use strict';
const fs = require('fs');
const dns = require('dns');
const http = require('http');

// Every device name in the official bundle (14), same list as docs/network.md.
const HOSTS = [
  'api.tiiny', 'auth.api.tiiny', 'wifi.api.tiiny', 'kb.api.tiiny', 'chat-history.api.tiiny',
  'tts.api.tiiny', 'p8800.api.tiiny', 'openai.api.tiiny', 'connector.api.tiiny',
  'backup.managed.tiiny', 'agent-services.api.tiiny', 'hardware-upgrade.api.tiiny',
  'anthropic.api.tiiny', 'ollama.api.tiiny',
];

/* /etc/hosts text -> Map(name -> address); the first line naming a host wins,
 * as in glibc. Comments and blank lines are skipped. */
function parseHosts(text) {
  const map = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [addr, ...names] = line.split(/\s+/);
    for (const n of names) if (!map.has(n.toLowerCase())) map.set(n.toLowerCase(), addr);
  }
  return map;
}

const lookup4 = (host) => dns.promises.lookup(host, { family: 4 }).then((r) => r.address);

/* GET http://<host>/ -> HTTP status, or throws with a short code
 * (ECONNREFUSED, EHOSTUNREACH, TIMEOUT, …). */
function probe(host, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
  });
}

const SERVICE_DOWN = new Set([502, 503, 504]);

/* One verdict per name. deviceIp = where api.tiiny resolves (the address the
 * rest should share), or null when api.tiiny itself does not resolve. */
function verdict(r, deviceIp) {
  if (!r.address) {
    return { verdict: 'missing', remedy: r.inHosts
      ? `In /etc/hosts but it does not resolve (${r.error || 'error'}): check the line for typos.`
      : 'Not in /etc/hosts: add it (line below).' };
  }
  if (deviceIp && r.address !== deviceIp) {
    return { verdict: 'elsewhere',
      remedy: `Points to ${r.address}, the device is at ${deviceIp}: fix this name in /etc/hosts.` };
  }
  if (r.http == null) {
    return { verdict: 'no-answer',
      remedy: `No answer from ${r.address} (${r.error || 'error'}): check the USB link and that the Pocket is on.` };
  }
  if (SERVICE_DOWN.has(r.http)) {
    return { verdict: 'service-down',
      remedy: `The device answers, this service does not (HTTP ${r.http}). It may start later; if it stays, restart the TiinyOS app.` };
  }
  return { verdict: 'ok', remedy: '' };
}

/* Run the check. deps: { hostsText, lookup(host), probe(host) } for tests. */
async function check(deps = {}) {
  let hostsText = deps.hostsText;
  if (hostsText == null) {
    try { hostsText = fs.readFileSync('/etc/hosts', 'utf8'); } catch { hostsText = ''; }
  }
  const look = deps.lookup || lookup4;
  const get = deps.probe || probe;
  const inFile = parseHosts(hostsText);

  const rows = await Promise.all(HOSTS.map(async (host) => {
    const r = { host, inHosts: inFile.has(host), address: null, http: null, error: null };
    try { r.address = await look(host); } catch (e) { r.error = e.code || e.message; return r; }
    try { r.http = await get(host); } catch (e) { r.error = e.code || e.message; }
    return r;
  }));

  const deviceIp = rows[0].address; // api.tiiny
  for (const r of rows) Object.assign(r, verdict(r, deviceIp));

  // The /etc/hosts line that fixes every missing or misdirected name.
  const fix = rows.filter((r) => r.verdict === 'missing' || r.verdict === 'elsewhere').map((r) => r.host);
  const hostsLine = fix.length ? `${deviceIp || '<device-ip>'} ${fix.join(' ')}` : '';

  return {
    readAt: Date.now(),
    deviceIp,
    ok: rows.filter((r) => r.verdict === 'ok').length,
    total: rows.length,
    hosts: rows,
    hostsLine,
  };
}

module.exports = { HOSTS, parseHosts, verdict, check, probe };
