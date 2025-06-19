/* ESM wrapper re-exporting the CommonJS implementation for browser usage. */

import cjsMod from './writer.js';

export const { Writer, WriterError, RecordType, buildHeader, buildImageMessage, buildImuMessage } = cjsMod;

export default cjsMod;
