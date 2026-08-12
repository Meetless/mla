/**
 * Writer for the machine-owned command-reference region (proposal §6.3, T6).
 *
 * The rendering rules live in `src/lib/command-reference.ts` (pure, typechecked,
 * unit-tested). This script is only the fs half: read the page, splice, write.
 *
 *   pnpm gen:command-reference           # rewrite the region
 *   pnpm gen:command-reference --check   # exit 1 on drift, write nothing
 *
 * The same render + compare also runs in `test/lib/command-registry.spec.ts`, so
 * CI catches drift even when this script is never invoked.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { COMMANDS } from "../src/cli";
import { renderCommandIndex, spliceCommandIndex } from "../src/lib/command-reference";

// .mdx, not .md. f8d0ccd88 renamed all 18 reference pages (they were .md carrying MDX, so
// every one leaked its import line), and this generator plus the freshness test in
// command-registry.spec.ts kept writing and reading the old extension. The generator
// silently created a SECOND, orphaned commands.md nobody renders, and the test ENOENTed.
const DOCS_PAGE = resolve(__dirname, "../../../../docs/src/content/docs/reference/commands.mdx");

const check = process.argv.includes("--check");
const current = readFileSync(DOCS_PAGE, "utf8");
const next = spliceCommandIndex(current, renderCommandIndex(COMMANDS));

if (current === next) {
  console.log("gen-command-reference: command index is fresh.");
  process.exit(0);
}

if (check) {
  console.error(
    "gen-command-reference --check: the command index in\n" +
      `  ${DOCS_PAGE}\n` +
      "is stale relative to the CLI command registry. Regenerate it with:\n" +
      "  pnpm --dir meetless-cli/packages/cli gen:command-reference",
  );
  process.exit(1);
}

writeFileSync(DOCS_PAGE, next);
console.log(`gen-command-reference: rewrote the command index in ${DOCS_PAGE}`);
