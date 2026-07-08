#!/usr/bin/env node
// validate-plugin.mjs: run `claude plugin validate --strict` against BOTH validation
// roots of the committed plugin tree: the marketplace root (meetless-cli/, which holds
// .claude-plugin/marketplace.json) AND the plugin subdir (meetless-cli/plugin/, which
// holds .claude-plugin/plugin.json). Both must be --strict-clean; the manifest carries
// a real semver (read from meetless-cli/packages/cli/package.json at generation time) so
// it passes strict. This wrapper NEVER mutates the tree; `plugin:validate` runs `plugin:check`
// first so drift is caught before validation, not silently regenerated away. Exits
// nonzero on the first failure.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const marketplaceRoot = path.join(here, ".."); // meetless-cli/ (marketplace.json)
const pluginDir = path.join(marketplaceRoot, "plugin"); // meetless-cli/plugin/ (plugin.json)

for (const [label, target] of [
  ["marketplace root", marketplaceRoot],
  ["plugin", pluginDir],
]) {
  // Arg order is `validate <target> --strict` (the documented positional-first form);
  // the target must precede the flag so the CLI binds it as the positional path.
  const r = spawnSync("claude", ["plugin", "validate", target, "--strict"], {
    stdio: "inherit",
  });
  if (r.error) {
    console.error(`could not run \`claude plugin validate\`: ${r.error.message}`);
    process.exit(2);
  }
  if ((r.status ?? 1) !== 0) {
    console.error(`\`claude plugin validate --strict\` failed for ${label} (${target})`);
    process.exit(r.status ?? 1);
  }
}
console.log("both the marketplace root and the plugin pass `claude plugin validate --strict`.");
