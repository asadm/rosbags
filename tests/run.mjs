/* Simple ESM test runner that imports test modules sequentially. */

try {
  await import('./test_writer1.js');
  await import('./test_writer_rosbag_read.js');
  console.log('\nAll JS tests passed');
} catch (err) {
  console.error('JS tests failed:', err);
  process.exit(1);
}
