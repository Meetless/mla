#!/usr/bin/env node
// Publish gate (proposal T34b, §0.01 clause 9, §10.1). A gate that depends on a
// human remembering not to run `pnpm publish` is not a gate. This runs as the
// `prepublishOnly` npm hook and HARD-FAILS (exit 1) unless BOTH hold:
//   (a) the BUILT CLI registers the `login`, `logout`, and `whoami` commands,
//       grepped from `node dist/cli.js --help` (the runtime manifest, NEVER the
//       source: a command can exist in src yet be unregistered in the binary);
//   (b) the env flag AUTH_BROWSER_LOGIN_READY=true is set. CI sets it ONLY after
//       Phase 5 e2e (T30 to T33) is green; it is never a developer's local
//       default, so a stray local `pnpm publish` aborts.
//
// `npm pack` does NOT run prepublishOnly, so packing/inspection stays unblocked;
// only `npm publish` / `pnpm publish` aborts. This is the executable form of the
// §10.1 prose gate, layered under `"private": true` (which is the deliberate,
// reviewable diff that must flip before any publish is even attempted).
const { execFileSync } = require("child_process");
const path = require("path");

const REQUIRED_COMMANDS = ["login", "logout", "whoami"];
const READY_FLAG = "AUTH_BROWSER_LOGIN_READY";

// Pure decision core: every branch is reachable from a unit test with in-memory
// strings, no build and no spawn required. `main()` is the only impure shell.
function evaluatePublishGate({ helpText, ready }) {
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
  if (ready !== true) {
    return {
      ok: false,
      reason:
        `publish gate FAILED: ${READY_FLAG} is not "true". This flag is set ONLY by the CI job ` +
        "that runs after Phase 5 e2e (T30 to T33) is green, never a local default. Refusing to publish.",
    };
  }
  return {
    ok: true,
    reason: "publish gate OK: login/logout/whoami registered in the built CLI and the e2e flag is set.",
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
  const result = evaluatePublishGate({ helpText, ready: process.env[READY_FLAG] === "true" });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(result.reason);
}

if (require.main === module) {
  main();
}

module.exports = { evaluatePublishGate, readBuiltHelp, REQUIRED_COMMANDS, READY_FLAG };
