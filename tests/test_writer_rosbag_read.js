// Round-trip test: write with project’s Writer, read back with the official
// `rosbag` npm package to verify on-disk compatibility.

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const { Writer } = require('../writer');

const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

function mkbag(name) {
  return path.join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.bag`);
}

// ---------------------------------------------------------------------------
//  Round-trip against rosbag npm dep
// ---------------------------------------------------------------------------

(() => {
  const bagPath = mkbag('roundtrip');

  // 1) Write a simple bag using project’s JS Writer implementation.
  const writer = new Writer(bagPath);
  writer.open();
  const conn = writer.addConnection('/foo', 'std_msgs/msg/Int8');
  writer.write(conn, 10, Buffer.from([0x2a])); // 42
  writer.write(conn, 11, Buffer.from([0x43])); // 67
  writer.close();

  // 2) Read back using rosbag (npm) in a separate Node process so that we can
  // synchronously capture the results.
  const readerScript = `
    const rosbag = require('rosbag');
    (async () => {
      const bag = await rosbag.open(process.argv[1]);
      const msgs = [];
      await bag.readMessages({ noParse: true }, (r) => {
        msgs.push({ topic: r.topic, data: r.data.toString('hex') });
      });
      console.log(JSON.stringify(msgs));
    })().catch(e => { console.error(e); process.exit(1); });
  `;

  const res = spawnSync('node', ['-e', readerScript, bagPath], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') },
  });

  if (res.status !== 0) {
    throw new Error(`rosbag reader process failed:\n${res.stderr || res.stdout}`);
  }

  const messages = JSON.parse(res.stdout.trim());

  assert.strictEqual(messages.length, 2, 'Should read two messages');
  assert.ok(messages.every((m) => m.topic === '/foo'));
  assert.strictEqual(messages[0].data, '2a'); // 0x2a → 42
  assert.strictEqual(messages[1].data, '43'); // 0x43 → 67
})();
