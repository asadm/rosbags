/*
 * Minimal ROS1 (bag v2.0) writer in Node.js.
 * Ported from https://github.com/Ternaris/rosbags src/rosbags/rosbag1/writer.py
 *
 * Supported features:
 *   • No compression (compression="none")
 *   • Same on-disk layout as reference implementation
 *   • addConnection / write / close API similar to Python version
 *
 * The implementation is intentionally kept lean to serve as reference and for
 * browser bundling.  It omits advanced message-definition generation – we only
 * embed the pieces required for the migrated unit-tests.
 */


// Optional fs import (Node only).
let fs;
try {
  // eslint-disable-next-line global-require
  fs = require('fs');
} catch (_) {
  fs = null; // running in browser / no fs available.
}

// ---------------------------------------------------------------------------
// Helpers: primitive serializers
// ---------------------------------------------------------------------------

function serializeUInt8(val) {
  const buf = Buffer.allocUnsafe(1);
  buf.writeUInt8(val, 0);
  return buf;
}

function serializeUInt32(val) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(val >>> 0, 0); // force uint32
  return buf;
}

function serializeUInt64(val) {
  const buf = Buffer.allocUnsafe(8);
  // Accept number or bigint.  Node >=12 supports writeBigUInt64LE.
  buf.writeBigUInt64LE(BigInt(val), 0);
  return buf;
}

function serializeTime(ns) {
  const sec = Math.floor(ns / 1e9);
  const nsec = ns % 1e9;
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(sec >>> 0, 0);
  buf.writeUInt32LE(nsec >>> 0, 4);
  return buf;
}

// ---------------------------------------------------------------------------
// Header object (key/value map → serialized record)
// ---------------------------------------------------------------------------

class Header {
  constructor() {
    this.fields = new Map(); // key → Buffer
  }

  setUint32(name, value) {
    this.fields.set(name, serializeUInt32(value));
  }

  setUint64(name, value) {
    this.fields.set(name, serializeUInt64(value));
  }

  setString(name, value) {
    this.fields.set(name, Buffer.from(String(value)));
  }

  setTime(name, value) {
    this.fields.set(name, serializeTime(value));
  }

  /**
   * Serialize header and optionally prepend opcode.
   * @param {number|undefined} opcode
   * @returns {Buffer}
   */
  serialize(opcode) {
    const parts = [];
    let dataLength = 0;

    // optional opcode field comes first
    if (opcode !== undefined) {
      const keqv = Buffer.concat([Buffer.from('op='), serializeUInt8(opcode)]);
      parts.push(serializeUInt32(keqv.length));
      parts.push(keqv);
      dataLength += 4 + keqv.length;
    }

    for (const [key, value] of this.fields) {
      const keqv = Buffer.concat([Buffer.from(key + '='), value]);
      parts.push(serializeUInt32(keqv.length));
      parts.push(keqv);
      dataLength += 4 + keqv.length;
    }

    return Buffer.concat([serializeUInt32(dataLength), ...parts], 4 + dataLength);
  }
}

// ---------------------------------------------------------------------------
// RecordType enum (mirror Python IntEnum values)
// ---------------------------------------------------------------------------

const RecordType = {
  MSGDATA: 2,
  BAGHEADER: 3,
  IDXDATA: 4,
  CHUNK: 5,
  CHUNK_INFO: 6,
  CONNECTION: 7,
};

// ---------------------------------------------------------------------------
// Utility: connection definition
// ---------------------------------------------------------------------------

class ConnectionExtRosbag1 {
  constructor(callerid, latching) {
    this.callerid = callerid ?? null;
    this.latching = latching ?? null;
  }
}

class Connection {
  constructor(id, topic, msgtype, msgdef, md5sum, ext) {
    this.id = id;
    this.topic = topic;
    this.msgtype = msgtype;
    this.msgdef = msgdef;
    this.md5sum = md5sum;
    this.ext = ext; // ConnectionExtRosbag1
  }
}

// ---------------------------------------------------------------------------
// WriteChunk helper
// ---------------------------------------------------------------------------

class WriteChunk {
  constructor() {
    this.dataParts = []; // Array<Buffer>
    this.size = 0;
    this.pos = -1;
    this.start = Number.MAX_SAFE_INTEGER; // 2^64 large substitute
    this.end = 0;
    // Map<cId, Array<[time, offset]>>
    this.connections = new Map();
  }

  /** Append buffer to chunk */
  push(buf) {
    this.dataParts.push(buf);
    this.size += buf.length;
  }

  /** Get current offset inside chunk */
  get offset() {
    return this.size;
  }

  /** Concat into single buffer */
  toBuffer() {
    if (this.dataParts.length === 1) return this.dataParts[0];
    return Buffer.concat(this.dataParts, this.size);
  }
}

// ---------------------------------------------------------------------------
// Writer implementation
// ---------------------------------------------------------------------------

class WriterError extends Error {}

class Writer {
  /**
   * Create new Writer.
   *
   * If `dest` is a string ⇒ treated as filesystem path (Node).
   * Otherwise, data will be kept in memory and can be retrieved via
   * `writer.getUint8Array()` (suitable for browser usage).
   *
   * @param {string|undefined} dest
   */
  constructor(dest) {
    this.path = typeof dest === 'string' ? dest : null;

    // in-memory mode when path is not provided
    this._inMemory = !this.path;

    if (!this._inMemory && fs && fs.existsSync(this.path)) {
      throw new WriterError(`${this.path} exists already, not overwriting.`);
    }

    this.fd = null; // file descriptor (Node only)
    this._buffers = []; // in-memory sink (Uint8Array[])
    this.filePos = 0; // absolute position counter

    this.compressionFormat = 'none';
    this.connections = [];
    this.chunkThreshold = 1 * (1 << 20); // 1 MiB
    this.chunks = [new WriteChunk()];
  }

  // Compression is unsupported beyond setting to 'none' for now.
  setCompression(/*fmt*/) {
    throw new WriterError('Compression not supported in JS port yet.');
  }

  /** Open bag for writing (called implicitly by first write if needed). */
  open() {
    if (this.fd !== null || this._opened) return; // already open

    if (!this._inMemory) {
      if (!fs) throw new WriterError('fs module not available in this environment.');
      this.fd = fs.openSync(this.path, 'wx');
    }

    const magic = Buffer.from('#ROSBAG V2.0\n');
    this._writeToBag(magic);

    const header = new Header();
    header.setUint64('index_pos', 0);
    header.setUint32('conn_count', 0);
    header.setUint32('chunk_count', 0);
    const headerBuf = header.serialize(RecordType.BAGHEADER);
    this._writeToBag(headerBuf);

    const padsize = 4096 - 4 - (headerBuf.length - 4);
    const padBuf = Buffer.concat([serializeUInt32(padsize), Buffer.alloc(padsize, 0x20)]);
    this._writeToBag(padBuf);

    this._opened = true;
  }

  /** internal sink */
  _writeToBag(buf) {
    if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
      throw new Error('Expected Buffer/Uint8Array');
    }
    if (this._inMemory) {
      this._buffers.push(Buffer.from(buf)); // ensure Buffer for consistency
      this.filePos += buf.length;
    } else {
      fs.writeSync(this.fd, buf, 0, buf.length, this.filePos);
      this.filePos += buf.length;
    }
  }

  /**
   * Add a connection, returning a Connection object (id usable in #write)
   */
  addConnection(
    topic,
    msgtype,
    msgdef = null,
    md5sum = null,
    { callerid = null, latching = null } = {},
  ) {
    if (!this._opened) {
      throw new WriterError('Bag was not opened.');
    }

    // -----------------------------------------------------------------------
    // Auto-populate well-known message definitions / md5 sums when the caller
    // did not supply them.  This keeps the public API small while still being
    // convenient for common use-cases (HTML demo, unit tests).
    // -----------------------------------------------------------------------

    const PREDEFINED_BASE = {
      'std_msgs/msg/Int8': {
        msgdef: 'int8 data\n',
        md5sum: '27ffa0c9c4b8fb8492252bcad9e5c57b',
      },
      'sensor_msgs/msg/CompressedImage': {
        msgdef: 'std_msgs/Header header\nstring format\nuint8[] data\n',
        md5sum: '8f7a12909da2c9d3332d540a0977563f',
      },
      // Standard uncompressed image message (ROS1).
      'sensor_msgs/msg/Image': {
        /* eslint-disable max-len */
        msgdef:
          '# This message contains an uncompressed image\n' +
          '# (0, 0) is at top-left corner of image\n' +
          '#\n' +
          '\n' +
          'Header header        # Header timestamp should be acquisition time of image\n' +
          '                     # Header frame_id should be optical frame of camera\n' +
          '                     # origin of frame should be optical center of camera\n' +
          '                     # +x should point to the right in the image\n' +
          '                     # +y should point down in the image\n' +
          '                     # +z should point into to plane of the image\n' +
          '                     # If the frame_id here and the frame_id of the CameraInfo\n' +
          '                     # message associated with the image conflict\n' +
          '                     # the behavior is undefined\n' +
          '\n' +
          'uint32 height         # image height, that is, number of rows\n' +
          'uint32 width          # image width, that is, number of columns\n' +
          '\n' +
          '# The legal values for encoding are in file src/image_encodings.cpp\n' +
          '# If you want to standardize a new string format, join\n' +
          '# ros-users@lists.sourceforge.net and send an email proposing a new encoding.\n' +
          '\n' +
          'string encoding       # Encoding of pixels -- channel meaning, ordering, size\n' +
          '                      # taken from the list of strings in include/sensor_msgs/image_encodings.h\n' +
          '\n' +
          'uint8 is_bigendian    # is this data bigendian?\n' +
          'uint32 step           # Full row length in bytes\n' +
          'uint8[] data          # actual matrix data, size is (step * rows)\n' +
          '\n' +
          '================================================================================\n' +
          'MSG: std_msgs/Header\n' +
          '# Standard metadata for higher-level stamped data types.\n' +
          '# This is generally used to communicate timestamped data \n' +
          '# in a particular coordinate frame.\n' +
          '# \n' +
          '# sequence ID: consecutively increasing ID \n' +
          'uint32 seq\n' +
          '#Two-integer timestamp that is expressed as:\n' +
          '#   * stamp.sec: seconds (stamp_secs) since epoch (in Python the variable is called \'secs\')\n' +
          '#   * stamp.nsec: nanoseconds since stamp_secs (in Python the variable is called \'nsecs\')\n' +
          '# time-handling sugar is provided by the client library\n' +
          'time stamp\n' +
          '#Frame this data is associated with\n' +
          'string frame_id\n',
        /* eslint-enable max-len */
        md5sum: '060021388200f6f0f447d0fcd9c64743',
      },
      // Standard IMU message (ROS1).
      'sensor_msgs/msg/Imu': {
        /* eslint-disable max-len */
        msgdef:
          '# This is a message to hold data from an IMU (Inertial Measurement Unit)\n' +
          '#\n' +
          '# Accelerations should be in m/s^2 (not in g\'s), and rotational velocity should be in rad/sec\n' +
          '#\n' +
          '# If the covariance of the measurement is known, it should be filled in (if all you know is the \n' +
          '# variance of each measurement, e.g. from the datasheet, just put those along the diagonal)\n' +
          '# A covariance matrix of all zeros will be interpreted as "covariance unknown", and to use the\n' +
          '# data a covariance will have to be assumed or gotten from some other source\n' +
          '#\n' +
          '# If you have no estimate for one of the data elements (e.g. your IMU doesn\'t produce an orientation \n' +
          '# estimate), please set element 0 of the associated covariance matrix to -1\n' +
          '# If you are interpreting this message, please check for a value of -1 in the first element of each \n' +
          '# covariance matrix, and disregard the associated estimate.\n' +
          '\n' +
          'Header header\n' +
          '\n' +
          'geometry_msgs/Quaternion orientation\n' +
          'float64[9] orientation_covariance # Row major about x, y, z axes\n' +
          '\n' +
          'geometry_msgs/Vector3 angular_velocity\n' +
          'float64[9] angular_velocity_covariance # Row major about x, y, z axes\n' +
          '\n' +
          'geometry_msgs/Vector3 linear_acceleration\n' +
          'float64[9] linear_acceleration_covariance # Row major x, y z \n' +
          '\n' +
          '================================================================================\n' +
          'MSG: std_msgs/Header\n' +
          '# Standard metadata for higher-level stamped data types.\n' +
          '# This is generally used to communicate timestamped data \n' +
          '# in a particular coordinate frame.\n' +
          '# \n' +
          '# sequence ID: consecutively increasing ID \n' +
          'uint32 seq\n' +
          '#Two-integer timestamp that is expressed as:\n' +
          '#   * stamp.sec: seconds (stamp_secs) since epoch (in Python the variable is called \'secs\')\n' +
          '#   * stamp.nsec: nanoseconds since stamp_secs (in Python the variable is called \'nsecs\')\n' +
          '# time-handling sugar is provided by the client library\n' +
          'time stamp\n' +
          '#Frame this data is associated with\n' +
          'string frame_id\n' +
          '\n' +
          '================================================================================\n' +
          'MSG: geometry_msgs/Quaternion\n' +
          '# This represents an orientation in free space in quaternion form.\n' +
          '\n' +
          'float64 x\n' +
          'float64 y\n' +
          'float64 z\n' +
          'float64 w\n' +
          '\n' +
          '================================================================================\n' +
          'MSG: geometry_msgs/Vector3\n' +
          '# This represents a vector in free space. \n' +
          '# It is only meant to represent a direction. Therefore, it does not\n' +
          '# make sense to apply a translation to it (e.g., when applying a \n' +
          '# generic rigid transformation to a Vector3, tf2 will only apply the\n' +
          '# rotation). If you want your data to be translatable too, use the\n' +
          '# geometry_msgs/Point message instead.\n' +
          '\n' +
          'float64 x\n' +
          'float64 y\n' +
          'float64 z\n',
        /* eslint-enable max-len */
        md5sum: '6a62c6daae103f4ff57a132d6f95cec2',
      },
    };

    // Also support ROS1-style type strings without the '/msg' component so the
    // bags can be consumed by tools that expect e.g. 'sensor_msgs/Image'.
    const PREDEFINED = { ...PREDEFINED_BASE };
    for (const [full, info] of Object.entries(PREDEFINED_BASE)) {
      const alias = full.replace('/msg/', '/');
      PREDEFINED[alias] = info;
    }

    if (msgdef === null || md5sum === null) {
      const predef = PREDEFINED[msgtype];
      if (predef) {
        if (msgdef === null) msgdef = predef.msgdef;
        if (md5sum === null) md5sum = predef.md5sum;
      }
    }

    if (msgdef === null || md5sum === null) {
      throw new WriterError('msgdef and md5sum required (auto-generation not implemented)');
    }

    const connection = new Connection(
      this.connections.length,
      topic,
      msgtype,
      msgdef,
      md5sum,
      new ConnectionExtRosbag1(callerid, latching),
    );

    // ensure uniqueness (mirror python logic: identical arguments after `id` are disallowed)
    const isDuplicate = this.connections.some((x) =>
      x.topic === connection.topic &&
      x.msgtype === connection.msgtype &&
      x.msgdef === connection.msgdef &&
      x.md5sum === connection.md5sum &&
      (x.ext.callerid ?? null) === (connection.ext.callerid ?? null) &&
      (x.ext.latching ?? null) === (connection.ext.latching ?? null)
    );
    if (isDuplicate) {
      throw new WriterError('Connections can only be added once with same arguments: ' + JSON.stringify(connection));
    }

    // write connection immediately into current chunk
    this._writeConnectionRecord(connection, this.chunks[this.chunks.length - 1]);

    this.connections.push(connection);
    return connection;
  }

  /** Write a message */
  write(connection, timestamp, data) {
    if (!this._opened) throw new WriterError('Bag was not opened.');

    if (!this.connections.includes(connection)) {
      throw new WriterError(`There is no connection ${connection.id}.`);
    }

    const chunk = this.chunks[this.chunks.length - 1];

    // add index entry
    if (!chunk.connections.has(connection.id)) {
      chunk.connections.set(connection.id, []);
    }
    chunk.connections.get(connection.id).push([timestamp, chunk.offset]);

    // update start/end times
    chunk.start = Math.min(chunk.start, timestamp);
    chunk.end = Math.max(chunk.end, timestamp);

    // build message record
    const header = new Header();
    header.setUint32('conn', connection.id);
    header.setTime('time', timestamp);
    const headerBuf = header.serialize(RecordType.MSGDATA);

    const lenBuf = serializeUInt32(data.length);
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    chunk.push(headerBuf);
    chunk.push(lenBuf);
    chunk.push(dataBuf);

    if (chunk.size > this.chunkThreshold) {
      this._writeChunk(chunk);
    }
  }

  /** Write connection record (two headers) into given chunk */
  _writeConnectionRecord(connection, chunk) {
    // first header: connection information (topic & conn id)
    const h1 = new Header();
    h1.setUint32('conn', connection.id);
    h1.setString('topic', connection.topic);
    chunk.push(h1.serialize(RecordType.CONNECTION));

    // second header: metadata
    const h2 = new Header();
    h2.setString('topic', connection.topic);
    h2.setString('type', connection.msgtype);
    h2.setString('md5sum', connection.md5sum);
    h2.setString('message_definition', connection.msgdef);
    if (connection.ext.callerid !== null) {
      h2.setString('callerid', connection.ext.callerid);
    }
    if (connection.ext.latching !== null) {
      h2.setString('latching', String(connection.ext.latching));
    }
    chunk.push(h2.serialize());
  }

  /** Write (and close) an existing WriteChunk to the bag file */
  _writeChunk(chunk) {
    if (chunk.size === 0) return; // nothing to do

    // ensure file is open
    if (!this._opened) throw new WriterError('Bag is closed.');

    chunk.pos = this.filePos;

    // chunk header
    const h = new Header();
    h.setString('compression', this.compressionFormat);
    h.setUint32('size', chunk.size);
    const headerBuf = h.serialize(RecordType.CHUNK);
    this._writeToBag(headerBuf);

    // chunk data (no compression)
    const chunkDataBuf = chunk.toBuffer();
    const chunkSizeBuf = serializeUInt32(chunkDataBuf.length);
    this._writeToBag(chunkSizeBuf);
    this._writeToBag(chunkDataBuf);

    // per-connection indexes within this chunk
    for (const [cid, items] of chunk.connections.entries()) {
      const idxHeader = new Header();
      idxHeader.setUint32('ver', 1);
      idxHeader.setUint32('conn', cid);
      idxHeader.setUint32('count', items.length);
      const idxHeaderBuf = idxHeader.serialize(RecordType.IDXDATA);
      this._writeToBag(idxHeaderBuf);

      const idxDataSizeBuf = serializeUInt32(items.length * 12);
      this._writeToBag(idxDataSizeBuf);

      for (const [time, offset] of items) {
        const entryBuf = Buffer.concat([serializeTime(time), serializeUInt32(offset)]);
        this._writeToBag(entryBuf);
      }
    }

    // reset chunk for new data collection
    this.chunks.push(new WriteChunk());
  }

  /** Close writer gracefully. */
  close() {
    if (!this._opened) return; // already closed

    // write any open chunk
    const openChunk = this.chunks[this.chunks.length - 1];
    if (openChunk.pos === -1) {
      this._writeChunk(openChunk);
    }

    const indexPos = this.filePos;

    // helper for sink writing within this scope
    const sink = {
      push: (buf) => this._writeToBag(buf),
    };

    for (const conn of this.connections) {
      this._writeConnectionRecord(conn, sink);
    }

    // write CHUNK_INFO records
    for (const chunk of this.chunks) {
      if (chunk.pos === -1) continue;

      const infoHeader = new Header();
      infoHeader.setUint32('ver', 1);
      infoHeader.setUint64('chunk_pos', chunk.pos);
      infoHeader.setTime('start_time', chunk.start === Number.MAX_SAFE_INTEGER ? 0 : chunk.start);
      infoHeader.setTime('end_time', chunk.end);
      infoHeader.setUint32('count', chunk.connections.size);
      const infoHeaderBuf = infoHeader.serialize(RecordType.CHUNK_INFO);
      this._writeToBag(infoHeaderBuf);

      const connInfoBuf = Buffer.allocUnsafe(chunk.connections.size * 8);
      let off = 0;
      for (const [cid, items] of chunk.connections.entries()) {
        serializeUInt32(cid).copy(connInfoBuf, off); off += 4;
        serializeUInt32(items.length).copy(connInfoBuf, off); off += 4;
      }
      this._writeToBag(serializeUInt32(connInfoBuf.length));
      this._writeToBag(connInfoBuf);
    }

    // rewrite BAGHEADER with correct counts & index position
    const finalHeader = new Header();
    finalHeader.setUint64('index_pos', indexPos);
    finalHeader.setUint32('conn_count', this.connections.length);
    finalHeader.setUint32('chunk_count', this.chunks.filter((c) => c.pos !== -1).length);
    const finalHeaderBuf = finalHeader.serialize(RecordType.BAGHEADER);

    const padsize = 4096 - 4 - (finalHeaderBuf.length - 4);
    const padBuf = Buffer.concat([serializeUInt32(padsize), Buffer.alloc(padsize, 0x20)]);

    // position 13 right after magic header
    if (this._inMemory) {
      // overwrite in-memory header region (offset 13)
      const arr = Buffer.concat(this._buffers);
      finalHeaderBuf.copy(arr, 13);
      padBuf.copy(arr, 13 + finalHeaderBuf.length);
      this._finalData = arr; // store for retrieval
    } else {
      fs.writeSync(this.fd, finalHeaderBuf, 0, finalHeaderBuf.length, 13);
      fs.writeSync(this.fd, padBuf, 0, padBuf.length, 13 + finalHeaderBuf.length);
      fs.closeSync(this.fd);
      this.fd = null;
    }

    this._opened = false;
  }

  /**
   * For in-memory mode returns the Uint8Array representing the bag (after
   * close()).  In Node/path mode returns undefined.
   */
  getUint8Array() {
    if (!this._inMemory) {
      throw new WriterError('Bag was written to filesystem, not in-memory.');
    }
    if (!this._finalData) {
      throw new WriterError('Bag not closed yet.');
    }
    return this._finalData;
  }
}

// ---------------------------------------------------------------------------
// Convenience payload builders for common message types
// ---------------------------------------------------------------------------

function _packString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([serializeUInt32(buf.length), buf]);
}

function _serializeFloat64(val) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(val, 0);
  return buf;
}

function _packFloat64Array(arr) {
  return Buffer.concat(arr.map(_serializeFloat64));
}

/** Build std_msgs/Header. Returns Buffer */
function buildHeader(stampNs, frameId = '', seq = 0) {
  const headerParts = [];
  headerParts.push(serializeUInt32(seq));
  const BILLION = 1000000000n;
  const sec = Number(stampNs / BILLION);
  const nsec = Number(stampNs % BILLION);
  headerParts.push(serializeUInt32(sec));
  headerParts.push(serializeUInt32(nsec));
  headerParts.push(_packString(frameId));
  return Buffer.concat(headerParts);
}

/**
 * Build sensor_msgs/Image message (raw/uncompressed).
 *
 * Note: encoding string must match pixel data layout provided in `data`.
 * Common values include 'mono8', 'rgb8', 'rgba8'…
 */
function buildImageMessage({
  stampNs = 0n,
  frameId = '',
  height,
  width,
  encoding = 'rgba8',
  isBigEndian = 0,
  data,
  step, // bytes per row. If omitted computed as width * channels
}) {
  let typedData = data;
  const isClamped = typeof Uint8ClampedArray !== 'undefined' && typedData instanceof Uint8ClampedArray;
  if (!(typedData instanceof Uint8Array) && !isClamped) {
    throw new Error('data must be Uint8Array');
  }

  // Convert Uint8ClampedArray → Uint8Array if necessary (browser ImageData).
  if (isClamped) {
    typedData = new Uint8Array(typedData.buffer, typedData.byteOffset, typedData.byteLength);
  }

  // heuristically derive step if not provided
  if (step === undefined) {
    const channels = {
      mono8: 1,
      mono16: 2,
      rgb8: 3,
      bgr8: 3,
      rgba8: 4,
      bgra8: 4,
    }[encoding] ?? 0;
    if (channels === 0) throw new Error('step must be provided for unknown encoding');
    step = width * channels;
  }

  // Serialize message
  const parts = [];
  parts.push(buildHeader(stampNs, frameId));
  parts.push(serializeUInt32(height));
  parts.push(serializeUInt32(width));
  parts.push(_packString(encoding));
  parts.push(serializeUInt8(isBigEndian));
  parts.push(serializeUInt32(step));
  parts.push(serializeUInt32(typedData.length));
  parts.push(Buffer.from(typedData));

  return Buffer.concat(parts);
}

/** Build sensor_msgs/Imu message */
function buildImuMessage({
  stampNs = 0n,
  frameId = '',
  orientation = [0, 0, 0, 1], // x,y,z,w
  orientationCov = Array(9).fill(-1), // -1 signals invalid
  angularVelocity = [0, 0, 0],
  angularVelCov = Array(9).fill(-1),
  linearAccel = [0, 0, 0],
  linearAccelCov = Array(9).fill(-1),
}) {
  const parts = [];
  parts.push(buildHeader(stampNs, frameId));
  parts.push(_packFloat64Array(orientation));
  parts.push(_packFloat64Array(orientationCov));
  parts.push(_packFloat64Array(angularVelocity));
  parts.push(_packFloat64Array(angularVelCov));
  parts.push(_packFloat64Array(linearAccel));
  parts.push(_packFloat64Array(linearAccelCov));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// module exports
// ---------------------------------------------------------------------------

// Support both ESM (import) and CommonJS (require).
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    Writer,
    WriterError,
    RecordType,
    buildHeader,
    buildImageMessage,
    buildImuMessage,
  };
}

// Expose to global (window / worker) so that a lightweight ESM wrapper can
// re-export the symbols without duplicating the full implementation.  This
// avoids CommonJS↔ESM interop issues in browsers.
if (typeof globalThis !== 'undefined') {
  // Do not clobber if another copy was loaded already.
  globalThis.__rosbagsWriter = globalThis.__rosbagsWriter ?? {
    Writer,
    WriterError,
    RecordType,
    buildHeader,
    buildImageMessage,
    buildImuMessage,
  };
}