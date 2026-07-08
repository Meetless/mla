import { execSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SCAN_SCHEMA_VERSION } from "../../src/lib/scanner/types";
import { SCOPED_UNAVAILABLE_MARKER_TEXT } from "../../src/lib/scanner/render";

// P3.2 hook integration test (targeted-rule-injection §Phase 3): exercise the REAL
// user-prompt-submit.sh bash hook driving the REAL built `mla _internal assemble-context`
// binary, end to end, so the two prompt-delivery paths the plan introduces are proven at the
// process boundary (not just in the assembler unit tests). This is the "does the wired-up hook
// actually put the byte-asserted rule head in front of the model" proof.
//
// The two paths (user-prompt-submit.sh §"assemble … + emit"):
//   Path 1 (assemble-context succeeded): the subcommand's byte-asserted head is emitted VERBATIM
//     as the whole additionalContext; NOTHING rule-wise is appended after it. Proven by the
//     `normal` and `old-schema` cases (the degraded head is still a non-empty SUCCESS output).
//   Path 2 (empty head = hard failure): the bash fallback delivers LAYER1 + the pre-rendered
//     floor XML. Proven by the `base-invariant` case (a floor too big for the budget makes the
//     subcommand throw BaseInvariantError, return null, and yield to the fallback).
//
// HERMETICITY: the real subcommand resolves its cache + audit under `homedir()` (which honors
// $HOME), while the hook's bash floor fallback reads `$MEETLESS_HOME/workspaces/<ws>/…`. We set
// HOME=<root> AND MEETLESS_HOME=<root>/.meetless so both resolve to the SAME sandbox cache at
// <root>/.meetless/workspaces/<ws>/scan-cache.json — no real ~/.meetless is touched. Layer 2 is
// self-skipped by omitting the auth token from cli-config.json, so no intel stub is needed, and
// a fresh session (turn 1) means no turn-recap / active-review trailing blocks: the emitted
// additionalContext is deterministically just the rule head (Path 1) or LAYER1 + floor (Path 2).

const CLI_ROOT = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(CLI_ROOT, "src");
const HOOKS_DIR = path.join(SRC_DIR, "hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";
const DIST_CLI = path.join(CLI_ROOT, "dist", "cli.js");
const WS = "ws_p32";

// Newest mtime (ms) of any file under `dir`, recursively. Used to detect a stale build: if any
// source file is newer than the compiled binary the test would otherwise exercise old code and
// pass/fail against the wrong bytes. Cheap enough for a one-time beforeAll.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

interface CacheSeed {
  schemaVersion: number;
  workspaceId: string;
  floorRulesXml: string;
  floorRules: Array<{ ruleId: string; versionId: string; text: string; strength: string }>;
  scopedRules: Array<{
    ruleId: string;
    versionId: string;
    text: string;
    strength: string;
    globs: string[];
  }>;
}

interface PersistedAudit {
  state: string;
  bytes: number;
  safeTotal: number;
  overflow: boolean;
  explicitPaths: string[];
  delivered: Array<{ ruleId: string; tier: string }>;
  omitted: Array<{ ruleId: string; reason: string }>;
}

interface RunResult {
  status: number;
  additionalContext: string | null;
  audit: PersistedAudit | null;
  stdout: string;
}

/** A fresh HOME/MEETLESS_HOME sandbox with the hook, common.sh, config, and a seeded cache. */
function makeSandbox(cache: CacheSeed): { root: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mla-p32-"));
  const home = path.join(root, ".meetless");
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.mkdirSync(path.join(home, "queue"), { recursive: true });
  const wsDir = path.join(home, "workspaces", WS);
  fs.mkdirSync(wsDir, { recursive: true });
  // The hook sources common.sh from its own dir (`$(dirname "$0")/common.sh`), so both live in root.
  fs.copyFileSync(COMMON, path.join(root, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(root, HOOK));
  fs.chmodSync(path.join(root, HOOK), 0o755);
  // No auth token: Layer 2 self-skips ("no auth token in config; Layer 1 only"), so the emitted
  // context is deterministically just the Layer-1 rule head with nothing appended after.
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: "http://127.0.0.1:1",
      workspaceId: WS,
      mlaPath: DIST_CLI,
    }),
  );
  fs.writeFileSync(path.join(wsDir, "scan-cache.json"), JSON.stringify(cache));
  return { root, home };
}

async function runHook(args: {
  root: string;
  home: string;
  sessionId: string;
  prompt: string;
}): Promise<RunResult> {
  const workdir = path.join(args.root, "workdir");
  fs.mkdirSync(workdir, { recursive: true });
  // Non-empty marker so meetless_activated() derives WORKSPACE_ID from `.workspaceId`.
  fs.writeFileSync(path.join(workdir, ".meetless.json"), JSON.stringify({ workspaceId: WS }) + "\n");
  const input = JSON.stringify({ session_id: args.sessionId, prompt: args.prompt });
  let out = "";
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn("bash", [path.join(args.root, HOOK)], {
      cwd: workdir,
      env: {
        ...process.env,
        HOME: args.root,
        MEETLESS_HOME: args.home,
        MEETLESS_DEBUG: "0",
      },
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
    child.stdin.write(input);
    child.stdin.end();
  });
  let additionalContext: string | null = null;
  const trimmed = out.trim();
  if (trimmed.startsWith("{")) {
    try {
      additionalContext = JSON.parse(trimmed)?.hookSpecificOutput?.additionalContext ?? null;
    } catch {
      additionalContext = null;
    }
  }
  const auditFile = path.join(args.home, "workspaces", WS, "assemble-audit.json");
  let audit: PersistedAudit | null = null;
  if (fs.existsSync(auditFile)) {
    try {
      audit = JSON.parse(fs.readFileSync(auditFile, "utf8")) as PersistedAudit;
    } catch {
      audit = null;
    }
  }
  return { status, additionalContext, audit, stdout: out };
}

const count = (s: string, sub: string): number => s.split(sub).length - 1;

const FLOOR_MUST_TEXT = "never push without explicit consent";
const SCOPED_MUST_TEXT = "guard the control outbox invariants";
const FLOOR_XML_SENTINEL = "FALLBACK-FLOOR-SENTINEL";

/** Current-schema (v2) cache: one global MUST floor + one explicit-path scoped MUST. */
function normalCache(): CacheSeed {
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    workspaceId: WS,
    floorRulesXml:
      '<meetless-context kind="floor-rules" trust="must-follow">\n' +
      `${FLOOR_XML_SENTINEL}\n- ${FLOOR_MUST_TEXT}\n</meetless-context>`,
    floorRules: [{ ruleId: "fm_push", versionId: "v1", text: FLOOR_MUST_TEXT, strength: "MUST" }],
    scopedRules: [
      {
        ruleId: "s_outbox",
        versionId: "v1",
        text: SCOPED_MUST_TEXT,
        strength: "MUST",
        globs: ["apps/control/**"],
      },
    ],
  };
}

describe("P3.2 hook integration — real user-prompt-submit.sh + real mla assemble-context binary", () => {
  const roots: string[] = [];

  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required for the assemble-head integration specs");
    // The test drives the REAL built binary: rebuild if it is missing OR any source file is newer
    // than the compiled `dist/cli.js` (a stale binary would silently exercise pre-edit code).
    const distStale =
      !fs.existsSync(DIST_CLI) || newestMtimeMs(SRC_DIR) > fs.statSync(DIST_CLI).mtimeMs;
    if (distStale) {
      execSync("npm run build", { cwd: CLI_ROOT, stdio: "ignore" });
    }
  }, 180000);

  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function sandbox(cache: CacheSeed): { root: string; home: string } {
    const s = makeSandbox(cache);
    roots.push(s.root);
    return s;
  }

  it("Path 1 (normal): emits the byte-asserted floor + explicit-scoped head, nothing appended after", async () => {
    const { root, home } = sandbox(normalCache());
    // The prompt NAMES an in-repo path under the scoped glob -> that scoped MUST becomes REQUIRED.
    const r = await runHook({
      root,
      home,
      sessionId: "sess-normal",
      prompt: "please update apps/control/outbox.ts to guard the outbox invariants",
    });

    expect(r.status).toBe(0);
    expect(r.additionalContext).not.toBeNull();
    const ctx = r.additionalContext!;

    // Both the global floor MUST and the explicit-matched scoped MUST reached the model.
    expect(ctx).toContain(FLOOR_MUST_TEXT);
    expect(ctx).toContain(SCOPED_MUST_TEXT);
    // The head is base(static) + floor-rules + scoped-rules — exactly one of each, no duplicates.
    expect(count(ctx, 'kind="static"')).toBe(1);
    expect(count(ctx, 'kind="floor-rules"')).toBe(1);
    expect(count(ctx, 'kind="scoped-rules"')).toBe(1);
    // No variable/degraded block trails the asserted head (Layer 2 skipped; turn 1; no gov/steer).
    for (const kind of [
      "evidence",
      "carry-forward",
      "coordination",
      "governance",
      "human-steer",
      "delivery-overflow",
      "delivery-incomplete",
      "scoped-unavailable",
    ]) {
      expect(ctx).not.toContain(`kind="${kind}"`);
    }

    // The audit proves the REAL subcommand success path ran (not the bash fallback): normal state,
    // both rules delivered by durable identity, under budget, the prompt path extracted.
    expect(r.audit).not.toBeNull();
    expect(r.audit!.state).toBe("normal");
    expect(r.audit!.overflow).toBe(false);
    expect(r.audit!.bytes).toBeLessThanOrEqual(r.audit!.safeTotal);
    expect(r.audit!.explicitPaths).toContain("apps/control/outbox.ts");
    expect(r.audit!.delivered).toEqual([
      { ruleId: "fm_push", tier: "floor-must" },
      { ruleId: "s_outbox", tier: "scoped-required" },
    ]);
    expect(r.audit!.omitted).toEqual([]);

    // No-append-after-assert: the delivered context is EXACTLY the byte-asserted head, so its UTF-8
    // byte length equals the count the assembler asserted under SAFE_TOTAL. Any trailing rule block
    // would break this equality.
    expect(Buffer.byteLength(ctx, "utf8")).toBe(r.audit!.bytes);
  });

  it("Path 1 (old-schema): a pre-activation cache still delivers the floor XML + a VISIBLE scoped-unavailable marker", async () => {
    // schemaVersion < current: the bulk compat path is gone, so scoped rules cannot be surfaced.
    // The subcommand still SUCCEEDS with a non-empty head (floor XML + a visible marker), so the
    // model is told delivery is degraded rather than silently seeing a floor-only prompt.
    const cache = normalCache();
    cache.schemaVersion = 1;
    const { root, home } = sandbox(cache);
    const r = await runHook({
      root,
      home,
      sessionId: "sess-old",
      prompt: "please update apps/control/outbox.ts",
    });

    expect(r.status).toBe(0);
    const ctx = r.additionalContext!;
    expect(ctx).toContain(FLOOR_XML_SENTINEL); // the pre-rendered floor XML rode through
    expect(ctx).toContain(SCOPED_UNAVAILABLE_MARKER_TEXT); // degradation is VISIBLE, not silent
    expect(r.audit).not.toBeNull();
    expect(r.audit!.state).toBe("old-schema");
  });

  it("Path 2 (base-invariant): an over-budget floor makes the subcommand yield, and the bash fallback delivers the last-good floor XML", async () => {
    // A global MUST so large that base + floor + marker cannot fit SAFE_TOTAL: assembleContext
    // throws BaseInvariantError, the subcommand returns null and prints NOTHING, and the hook's
    // bash fallback (LAYER1 + the pre-rendered floor XML) owns delivery instead. This exercises the
    // OTHER emit branch end to end.
    const cache = normalCache();
    cache.floorRules = [{ ruleId: "fm_big", versionId: "v1", text: "z".repeat(3000), strength: "MUST" }];
    cache.scopedRules = [];
    const { root, home } = sandbox(cache);
    const r = await runHook({
      root,
      home,
      sessionId: "sess-baseinv",
      prompt: "please update apps/control/outbox.ts",
    });

    expect(r.status).toBe(0);
    const ctx = r.additionalContext!;
    // The fallback delivered the last-known-good compiled floor XML, so the floor still reaches the
    // model even though the byte-budgeted head could not be produced.
    expect(ctx).toContain(FLOOR_XML_SENTINEL);
    expect(ctx).toContain('kind="static"'); // LAYER1 was re-emitted by the fallback branch
    // The giant structured floor text never rendered to stdout (only the pre-rendered XML did).
    expect(ctx).not.toContain("zzzz");
    // The audit records the base-invariant, observable out-of-band even though stdout came from bash.
    expect(r.audit).not.toBeNull();
    expect(r.audit!.state).toBe("base-invariant");
    expect(r.audit!.bytes).toBe(0);
  });
});
