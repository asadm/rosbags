// ESM build of writer for browser usage – wraps the CommonJS implementation
// and re-exports its symbols.  The main logic lives in writer.js so that the
// unit-tests (CommonJS) and browser demo (ESM) can share the same codebase
// without duplication.

// Ensure writer.js executed so that it attaches its API to globalThis.
import './writer.js';

const mod = globalThis.__rosbagsWriter;

export const {
  Writer,
  WriterError,
  RecordType,
  buildHeader,
  buildImageMessage,
  buildImuMessage,
} = mod;

export default mod;
