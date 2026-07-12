#!/usr/bin/env node
// Publish gate (proposal T34b, refined by the release-testing proposal Phase 0.4).
// A gate that depends on a human remembering not to run `pnpm publish` is not a
// gate. This runs as the `prepublishOnly` npm hook and HARD-FAILS (exit 1) unless
// the BUILT CLI registers the `login`, `logout`, and `whoami` commands, grepped
// from `node dist/cli.js --help` (the runtime manifest, NEVER the source: a
// command can exist in src yet be unregistered in the binary). Browser login is
// the floor for shipping to external operators, so a shared-key-only build (no
// login/logout/whoami) must never reach npm.
//
// The old AUTH_BROWSER_LOGIN_READY env flag was retired here: it was a
// hand-set "the e2e is green" affirmation that browser login had shipped. It
// has shipped (login/logout/whoami are permanent commands), the release-cli.yml
// npm job now smokes the exact publish tarball before it publishes, and the CI
// test suite is a required gate before any binary is built, so a second manual
// env flag added nothing but a footgun (a forgotten `AUTH_BROWSER_LOGIN_READY`
// aborting an otherwise-good release). Command registration is now the sole
// programmatic abort condition, layered under the reviewable `pnpm pack` +
// smoke steps in the workflow.
//
// `npm pack` does NOT run prepublishOnly, so packing/inspection stays unblocked;
// only `npm publish` / `pnpm publish` aborts.
const { execFileSync } = require("child_process");
const path = require("path");

const REQUIRED_COMMANDS = ["login", "logout", "whoami"];

// Pure decision core: every branch is reachable from a unit test with in-memory
// strings, no build and no spawn required. `main()` is the only impure shell.
function evaluatePublishGate({ helpText }) {
  const missing = REQUIRED_COMMANDS.filter(
    (cmd) => !new RegExp(`(^|\\s)mla ${cmd}(\\s|$)`, "m").test(helpText),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `publish gate FAILED: the built CLI is missing required command(s): ${missing.join(", ")}. ` +
        "Browser login is not shipped; refusing to publish a shared-key-only package to external operators.",
    };
  }
  return {
    ok: true,
    reason: "publish gate OK: login/logout/whoami registered in the built CLI.",
  };
}

function readBuiltHelp() {
  const cliPath = path.join(__dirname, "..", "dist", "cli.js");
  // The BUILT manifest, not the source. `--help` exits 0 and prints USAGE.
  return execFileSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main() {
  let helpText = "";
  try {
    helpText = readBuiltHelp();
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error(
      `publish gate FAILED: could not run \`node dist/cli.js --help\` (run \`pnpm build\` first). ${detail}`,
    );
    process.exit(1);
  }
  const result = evaluatePublishGate({ helpText });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(result.reason);
}

if (require.main === module) {
  main();
}

module.exports = { evaluatePublishGate, readBuiltHelp, REQUIRED_COMMANDS };
