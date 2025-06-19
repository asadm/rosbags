/* Simple test runner: requires all test files and exits non-zero on failure. */

try {
  require('./test_writer1');
  console.log('\nAll JS tests passed');
} catch (err) {
  console.error('JS tests failed:', err);
  process.exit(1);
}
