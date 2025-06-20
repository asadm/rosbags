/* Poly-fill for Node's Buffer on the web.

   esbuild will prepend this file to the browser bundle via the `--inject`
   flag so that all occurrences of `Buffer` are resolved without requiring the
   host page to add an extra <script> tag. */

import { Buffer } from 'buffer';

// Expose globally so libraries can rely on a global Buffer just like in Node.
if (typeof globalThis !== 'undefined' && !globalThis.Buffer) {
  // eslint-disable-next-line no-global-assign, no-undef
  globalThis.Buffer = Buffer;
}

export { Buffer };
