# rosbags – zero-dependency ROS1 bag writer for Node & the browser

This directory contains a *minimal* implementation of a ROS1 (format v2.0)
**bag writer** in pure JavaScript with **zero runtime dependencies** – not even
`buffer` (we prebundle a polyfill for browser), `ieee754` or friends.  The only 
modules it relies on are provided by Node.js itself (`fs`, `path`, …), which 
means it also works unchanged in the browser after bundling.

The code is a direct, line-for-line port of the
[rosbags](https://gitlab.com/ternaris/rosbags) reference implementation written
in Python.  All record layouts, headers and constants are identical, so a bag
produced here can be opened with any existing ROS tooling.

---

## Quick start

```bash
# Run the small unit-test suite (writes & reads a few bags)
node js/tests/run.mjs
```

### Install via npm

```bash
npm install rosbags
```

### Usage in Node (ESM)

```js
import { Writer } from 'rosbags';

const bag = new Writer('example.bag');
bag.open();
const conn = bag.addConnection('/foo', 'std_msgs/msg/Int8');
bag.write(conn, 1, Buffer.from([0x01]));
bag.close();
```

### Usage in Node (CommonJS)

```js
const { Writer } = require('rosbags');
// ...identical to above
```

### Usage in the Browser via CDN

Add a single script tag that exposes `rosbagsWriter` globally:

```html
<script src="https://unpkg.com/rosbags/dist/rosbags.browser.js"></script>
<script>
  // The bundle already contains a Buffer poly-fill, no extra scripts needed.
  const { Writer } = rosbagsWriter;
  const w = new Writer();
  w.open();
  const c = w.addConnection('/foo', 'std_msgs/msg/Int8');
  w.write(c, 123n, new Uint8Array([0x42]));
  w.close();
  const blob = new Blob([w.getUint8Array()], { type: 'application/octet-stream' });
  // download or upload blob here
</script>
```

---

### Write a bag on disk (from source checkout)

```js
// After installing from npm:
import { Writer } from 'rosbags'; // Node ESM variant

const bag = new Writer('example.bag');   // pass a path ⇒ write to disk
bag.open();

// Register a topic/connection first
const conn = bag.addConnection('/foo', 'std_msgs/msg/Int8');

// Then stream messages (timestamp in **nanoseconds**)
bag.write(conn, 1,  Buffer.from([0x01]));
bag.write(conn, 2,  Buffer.from([0x02]));

bag.close();
```

### Create a bag entirely in memory (browser-friendly)

```js
import { Writer } from 'rosbags';

const writer = new Writer();        // no path ⇒ keep data in memory
writer.open();
const conn = writer.addConnection('/bar', 'std_msgs/msg/Int8');
writer.write(conn, 42, new Uint8Array([0xff]));
writer.close();

const raw = writer.getUint8Array(); // Uint8Array containing the .bag file
// …upload, download or feed into a WebWorker here…
```

### Read the resulting bag with the official npm package

```js
const rosbag = require('rosbag');

(async () => {
  const bag = await rosbag.open('example.bag');
  await bag.readMessages({ noParse: true }, (msg) => {
    console.log(msg.topic, msg.data);
  });
})();
```

---

## Testing

Two kinds of tests live in `js/tests/`:

* `test_writer1.js` – verifies the writer against a set of hand-rolled
  assertions (header sizes, chunk flags, …).
* `test_writer_rosbag_read.js` – round-trip check that writes with *this*
  writer and reads back using the upstream `rosbag` npm dependency.

The tests load **`dist/rosbags.js`** (CommonJS stub) so they exercise the same
API surface without requiring a build step.  When you run `npm run build`, the
real bundles `dist/rosbags.node.mjs` (ESM) and `dist/rosbags.browser.js`
overwrite / complement the stub.

Run the suite via:

```bash
node js/tests/run.mjs

---

## Publishing to npm

The `package.json` includes convenience scripts:

* `npm run build` – Generates two self-contained bundles using
  [esbuild](https://esbuild.github.io/):
  * `dist/rosbags.node.mjs` (ESM for Node)
  * `dist/rosbags.browser.js` (IIFE for browsers)
* `npm publish` – Publish the package.  A `prepublishOnly` hook ensures the
  bundle is rebuilt and the tests are green before the actual upload.

Everything required at runtime is embedded in the generated bundle, so the
published module stays dependency-free.
```

---

## License

This JavaScript port is released under the MIT license (see `LICENSE`).
