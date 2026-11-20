// Engine lock: with two processes only the lock holder acts; the other one
// reads, refuses updates, writes nothing, and takes over when the holder quits.
// No device needed: nothing here polls.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

process.env.TIINY_BASE = 'http://127.0.0.1:9'; // never the real device
const care = require('../../src/m3_care');
const lock = require('../../src/m3_lock');

function holdLock(lockPath) {
  // a second process that takes the lock and waits on stdin
  const code = `const l=require(${JSON.stringify(path.resolve(__dirname, '../../src/m3_lock.js'))});` +
    `l.acquire(${JSON.stringify(lockPath)},{tool:'other'});process.stdout.write('held\\n');process.stdin.resume();`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

test('second process only reads until the holder quits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-lock-'));
  const lockPath = path.join(dir, 'engine.lock');
  const child = await holdLock(lockPath);
  try {
    care._reset();
    care.start({ baseDir: dir, pollMs: 0, lock: true });
    const st = care.state();
    assert.equal(st.engine.owner, false);
    assert.equal(st.engine.holder.pid, child.pid);
    assert.equal(st.engine.holder.tool, 'other');

    await assert.rejects(care.update('any'), /updates run in other \(pid \d+\)/);
    await assert.rejects(care.updateAll(), /updates run in other/);
    assert.equal(await care._startRestore(null), null);
    care.logEvent('test', 'must not be written');
    assert.equal(fs.existsSync(path.join(dir, 'care-log.jsonl')), false);

    child.kill();
    await new Promise((r) => child.once('exit', r));
    care._claim();
    assert.equal(care.state().engine.owner, true);
    assert.equal(lock.holder(lockPath).pid, process.pid);
    care.logEvent('test', 'now written');
    assert.ok(fs.readFileSync(path.join(dir, 'care-log.jsonl'), 'utf8').includes('now written'));

    care._reset(); // releases the lock
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
