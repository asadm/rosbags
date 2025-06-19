// Basic unit-tests for js/writer.js using Node's built-in assert module.

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Use the dist bundle stub for tests.
const { Writer, WriterError } = require('../dist/rosbags');

const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

function mkbag(name) {
  return path.join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.bag`);
}

function countBuf(buf, needle) {
  if (!Buffer.isBuffer(needle)) needle = Buffer.from(needle);
  let count = 0;
  let pos = 0;
  while ((pos = buf.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 1) overwrite protection
// ---------------------------------------------------------------------------

(() => {
  const bag = mkbag('overwrite');
  fs.writeFileSync(bag, 'foo');

  let threw = false;
  try {
    new Writer(bag); // constructor rejects existing file
  } catch (e) {
    threw = true;
    // fs.openSync throws native Error (EEXIST) here – not WriterError.
  }
  assert(threw, 'Writer should refuse to overwrite existing file');

  // path does not exist initially
  const bag2 = mkbag('overwrite2');
  const writer = new Writer(bag2);
  // create file in the meantime
  fs.writeFileSync(bag2, 'foo');
  threw = false;
  try {
    writer.open();
  } catch (e) {
    threw = true;
  }
  assert(threw, 'Writer.open should refuse to overwrite existing file');
})();

// ---------------------------------------------------------------------------
// 2) empty bag => length 13+4096 bytes
// ---------------------------------------------------------------------------

(() => {
  const bag = mkbag('empty');
  const w = new Writer(bag);
  w.open();
  w.close();
  const data = fs.readFileSync(bag);
  assert(
    data.length >= 13 + 4096,
    `Empty bag length (${data.length}) should be at least magic+pad (4109)`,
  );
})();

// ---------------------------------------------------------------------------
// 3) addConnection variations
// ---------------------------------------------------------------------------

(() => {
  const bag = mkbag('addconn');
  const w = new Writer(bag);

  // addConnection before open should fail
  let threw = false;
  try {
    w.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH');
  } catch (e) {
    threw = true;
    assert(e instanceof WriterError);
  }
  assert(threw, 'addConnection before open() must throw');

  w.open();
  const conn = w.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH');
  assert.strictEqual(conn.id, 0);
  w.close();

  const bytes = fs.readFileSync(bag);
  assert.strictEqual(countBuf(bytes, 'MESSAGE_DEFINITION'), 2, 'definition appears twice');
  assert.strictEqual(countBuf(bytes, 'HASH'), 2, 'hash appears twice');

  // auto-generated Int8 def/hash
  const bag2 = mkbag('addconn2');
  const w2 = new Writer(bag2);
  w2.open();
  const conn2 = w2.addConnection('/foo', 'std_msgs/msg/Int8');
  assert.strictEqual(conn2.id, 0);
  w2.close();
  const bytes2 = fs.readFileSync(bag2);
  assert.strictEqual(countBuf(bytes2, 'int8 data'), 2);
  assert.strictEqual(countBuf(bytes2, '27ffa0c9c4b8fb8492252bcad9e5c57b'), 2);
})();

// ---------------------------------------------------------------------------
// 4) write simple chunk with multiple connections / messages
// ---------------------------------------------------------------------------

(() => {
  const bag = mkbag('write');
  const w = new Writer(bag);
  w.open();

  const connFoo = w.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH');
  const connLatching = w.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH', { latching: 1 });
  const connBar = w.addConnection('/bar', 'test_msgs/msg/Bar', 'OTHER_DEFINITION', 'HASH', { callerid: 'src' });
  w.addConnection('/baz', 'test_msgs/msg/Baz', 'NEVER_WRITTEN', 'HASH');

  w.write(connFoo, 42, Buffer.from('DEADBEEF'));
  w.write(connLatching, 42, Buffer.from('DEADBEEF'));
  w.write(connBar, 43, Buffer.from('SECRET'));
  w.write(connBar, 43, Buffer.from('SUBSEQUENT'));

  w.close();

  const bytes = fs.readFileSync(bag);
  assert.strictEqual(countBuf(bytes, Buffer.from('op=\x05')), 1); // CHUNK
  assert.strictEqual(countBuf(bytes, Buffer.from('op=\x06')), 1); // CHUNK_INFO
  assert.strictEqual(countBuf(bytes, 'MESSAGE_DEFINITION'), 4);
  assert.strictEqual(countBuf(bytes, 'latching=1'), 2);
  assert.strictEqual(countBuf(bytes, 'OTHER_DEFINITION'), 2);
  assert.strictEqual(countBuf(bytes, 'callerid=src'), 2);
  assert.strictEqual(countBuf(bytes, 'NEVER_WRITTEN'), 2);
  assert.strictEqual(countBuf(bytes, 'DEADBEEF'), 2);
  assert.strictEqual(countBuf(bytes, 'SECRET'), 1);
  assert.strictEqual(countBuf(bytes, 'SUBSEQUENT'), 1);
})();

// ---------------------------------------------------------------------------
// 5) In-memory writer (browser scenario)
// ---------------------------------------------------------------------------

(() => {
  const writer = new Writer(); // no path ⇒ in-memory
  writer.open();
  const conn = writer.addConnection('/foo', 'std_msgs/msg/Int8');
  writer.write(conn, 123, Buffer.from([0x42]));
  writer.close();

  const arr = writer.getUint8Array();
  assert(arr instanceof Uint8Array);
  assert(arr.length > 4100);
  assert(Buffer.from(arr).includes(Buffer.from([0x42])));
})();

console.log('writer.js tests ok');
