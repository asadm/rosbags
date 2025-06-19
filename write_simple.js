#!/usr/bin/env node
/* Simple script used by the migrated pytest to generate a bag file via the JS writer. */
const { Writer } = require('./writer');

if (process.argv.length < 3) {
  console.error('Usage: write_simple.js <bag_path>');
  process.exit(1);
}

const bagPath = process.argv[2];

const writer = new Writer(bagPath);
writer.open();

const connFoo = writer.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH');
const connLatching = writer.addConnection('/foo', 'test_msgs/msg/Test', 'MESSAGE_DEFINITION', 'HASH', { latching: 1 });
const connBar = writer.addConnection('/bar', 'test_msgs/msg/Bar', 'OTHER_DEFINITION', 'HASH', { callerid: 'src' });
writer.addConnection('/baz', 'test_msgs/msg/Baz', 'NEVER_WRITTEN', 'HASH');

writer.write(connFoo, 42, Buffer.from('DEADBEEF'));
writer.write(connLatching, 42, Buffer.from('DEADBEEF'));
writer.write(connBar, 43, Buffer.from('SECRET'));
writer.write(connBar, 43, Buffer.from('SUBSEQUENT'));

writer.close();
