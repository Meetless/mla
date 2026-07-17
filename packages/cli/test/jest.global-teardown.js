// Drop this run's home root (see test/jest.global-setup.js). Best effort: a leftover temp dir is
// harmless, and it is ours alone, so no concurrent run can be caught by this rm.
const { rmSync } = require("node:fs");

module.exports = async () => {
  const root = process.env.MLA_TEST_HOME_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
};
