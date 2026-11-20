// Connection check: verdicts and the /etc/hosts fix line, with injected
// lookup/probe (no network, no real device).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { HOSTS, parseHosts, check } = require('../../src/m3_netcheck');

const IP = '10.9.9.2';
const OTHER = '10.9.9.7';

function fail(code) { return Promise.reject(Object.assign(new Error(code), { code })); }

test('parseHosts: first line wins, comments skipped, names lowercased', () => {
  const m = parseHosts(`# c\n${IP} api.tiiny Kb.api.tiiny # tail\n\n${OTHER} api.tiiny\n`);
  assert.equal(m.get('api.tiiny'), IP);
  assert.equal(m.get('kb.api.tiiny'), IP);
  assert.equal(m.size, 2);
});

test('the list matches the 14 names of docs/network.md', () => {
  const doc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'network.md'), 'utf8');
  const inDoc = new Set(doc.match(/[a-z0-9-]+(\.[a-z0-9-]+)*\.(api|managed)\.tiiny|\bapi\.tiiny\b/g));
  assert.equal(HOSTS.length, 14);
  assert.deepEqual([...inDoc].sort(), [...HOSTS].sort());
});

test('all good: every name ok, no fix line', async () => {
  const r = await check({
    hostsText: `${IP} ${HOSTS.join(' ')}`,
    lookup: async () => IP,
    probe: async () => 404,
  });
  assert.equal(r.ok, 14);
  assert.equal(r.deviceIp, IP);
  assert.equal(r.hostsLine, '');
  assert.ok(r.hosts.every((h) => h.inHosts && h.verdict === 'ok'));
});

test('missing, elsewhere, no answer, service down — each gets its verdict', async () => {
  const hostsText = `${IP} api.tiiny p8800.api.tiiny openai.api.tiiny\n${OTHER} kb.api.tiiny`;
  const map = parseHosts(hostsText);
  const r = await check({
    hostsText,
    lookup: async (h) => map.get(h) || fail('ENOTFOUND'),
    probe: async (h) => (h === 'openai.api.tiiny' ? fail('ECONNREFUSED') : h === 'p8800.api.tiiny' ? 502 : 200),
  });
  const by = Object.fromEntries(r.hosts.map((h) => [h.host, h]));
  assert.equal(by['api.tiiny'].verdict, 'ok');
  assert.equal(by['p8800.api.tiiny'].verdict, 'service-down');
  assert.match(by['p8800.api.tiiny'].remedy, /HTTP 502/);
  assert.equal(by['openai.api.tiiny'].verdict, 'no-answer');
  assert.match(by['openai.api.tiiny'].remedy, /ECONNREFUSED/);
  assert.equal(by['kb.api.tiiny'].verdict, 'elsewhere');
  assert.match(by['kb.api.tiiny'].remedy, new RegExp(`${OTHER}.*${IP}`));
  assert.equal(by['tts.api.tiiny'].verdict, 'missing');
  assert.equal(by['tts.api.tiiny'].inHosts, false);
  assert.equal(r.ok, 1);
  // the fix line names the device address and only the names to fix
  assert.ok(r.hostsLine.startsWith(IP + ' '));
  const fixed = r.hostsLine.split(' ').slice(1);
  assert.ok(fixed.includes('kb.api.tiiny') && fixed.includes('tts.api.tiiny'));
  assert.ok(!fixed.includes('api.tiiny') && !fixed.includes('openai.api.tiiny'));
  assert.equal(fixed.length, 10 + 1); // 10 missing + kb pointing elsewhere
});

test('api.tiiny itself missing: placeholder address in the fix line', async () => {
  const r = await check({ hostsText: '', lookup: () => fail('ENOTFOUND'), probe: async () => 200 });
  assert.equal(r.ok, 0);
  assert.equal(r.deviceIp, null);
  assert.equal(r.hostsLine, '<device-ip> ' + HOSTS.join(' '));
});

test('in /etc/hosts but not resolving: says so instead of "add it"', async () => {
  const r = await check({ hostsText: `${IP} ${HOSTS.join(' ')}`, lookup: () => fail('EAI_FAIL'), probe: async () => 200 });
  assert.match(r.hosts[0].remedy, /In \/etc\/hosts but it does not resolve \(EAI_FAIL\)/);
});
