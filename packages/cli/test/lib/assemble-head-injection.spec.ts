import { execSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SCAN_SCHEMA_VERSION } from "../../src/lib/scanner/types";
import { SCOPED_UNAVAILABLE_MARKER_TEXT } from "../../src/lib/scanner/render";
import { SAFE_TOTAL } from "../../src/commands/assemble-context";

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
//   Path 2 (over-budget floor): a floor larger than SAFE_TOTAL is delivered WHOLE by the subcommand
//     itself (the budget expands, since there is no harness cap to truncate it), so the byte-asserted
//     head still reaches the model and the bash fallback is never needed. This is the scenario that
//     once tripped the retired base invariant and yielded to the fallback; it now delivers whole.
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
  // Absent = an unstamped legacy cache, which the root guard TRUSTS. Set it to a directory that is
  // not the hook's cwd to reproduce the foreign-root case (several `.meetless.json` markers sharing
  // one workspace id, last scan wins the workspace-global slot).
  scanRootPath?: string;
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
  delivered: Array<{ ruleId: string; tier: string; versionId: string }>;
  omitted: Array<{ ruleId: string; reason: string }>;
}

// The per-turn DELIVERY receipt the hook stamps (user-prompt-submit.sh §emit_delivery_receipt).
// Every field is derived from the text bash actually emitted, which is the whole point: the
// previous `emit_floor_receipt` derived it from a jq read of the scan cache BEFORE the assembler
// ran, so it could only ever report "the cache has a floorRulesXml field". Across the 8h11m window
// in which every floor MUST was dropped it was byte-identical to a healthy turn's.
interface HookReceipt {
  at: string;
  path: "assembler" | "fallback" | "blocked" | "none";
  delivery: "emitted" | "missing";
  floorRules: number;
  scopedRules: number;
  bytes: number;
  cwd: string;
  freshness: string;
  bundleId: string;
  degraded?: string;
  reason?: string;
  bundleHash?: string;
}

interface RunResult {
  status: number;
  additionalContext: string | null;
  audit: PersistedAudit | null;
  receipt: HookReceipt | null;
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
  const readJson = <T,>(file: string): T | null => {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const wsDir = path.join(args.home, "workspaces", WS);
  const audit = readJson<PersistedAudit>(path.join(wsDir, "assemble-audit.json"));
  const receipt = readJson<HookReceipt>(path.join(wsDir, "hook-receipt.json"));
  return { status, additionalContext, audit, receipt, stdout: out };
}

/**
 * The receipt is only worth anything if it describes THIS turn's emitted head, so every
 * assertion below is cross-checked against the context string the same run returned. A receipt
 * that agrees with itself proves nothing; a receipt whose counts match an independent count of
 * the delivered text is the falsifiable version.
 */
function expectReceiptMatchesContext(r: RunResult): void {
  expect(r.receipt).not.toBeNull();
  const rec = r.receipt!;
  const ctx = r.additionalContext ?? "";
  expect(rec.bytes).toBe(Buffer.byteLength(ctx, "utf8"));
  expect(rec.delivery).toBe(ctx.includes('kind="floor-rules"') ? "emitted" : "missing");
  expect(rec.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

  it("Path 1 (foreign root): a cache stamped by ANOTHER checkout still delivers the workspace-global floor", async () => {
    // The 2026-08-02 outage, end to end at the process boundary. One workspace id is bound by
    // several `.meetless.json` markers; the last scan wins the workspace-global slot and stamps it
    // with ITS root, so every other root's guarded read returns null and the assembler takes Row 5.
    //
    // Row 5 used to emit base + marker only, and the bash hook could not make up for it: the head
    // below is a non-empty SUCCESS output, so the hook takes Path 1 and the `else` arm that appends
    // FLOOR_RULES never runs. Every floor MUST was silently dropped for 8h11m. The floor is
    // bundle-sourced and workspace-global, so the correct behavior is to lose ONLY the scoped rules.
    const seed = normalCache();
    seed.scanRootPath = path.join(os.tmpdir(), "some-other-checkout-that-does-not-exist");
    const { root, home } = sandbox(seed);
    const r = await runHook({
      root,
      home,
      sessionId: "sess-foreign-root",
      prompt: "please update apps/control/outbox.ts to guard the outbox invariants",
    });

    expect(r.status).toBe(0);
    const ctx = r.additionalContext!;
    // The floor MUST still reached the model.
    expect(ctx).toContain(FLOOR_MUST_TEXT);
    // The degradation is VISIBLE, and this marker is also the proof that the ASSEMBLER emitted this
    // head (Path 1): the bash fallback has no marker to emit.
    expect(ctx).toContain('kind="delivery-incomplete"');
    // The scoped rule is correctly withheld: it was parsed from a checkout that is not this one.
    expect(ctx).not.toContain(SCOPED_MUST_TEXT);
    // Exactly one floor block: the assembler's. Nothing double-appended by the fallback.
    expect(count(ctx, 'kind="floor-rules"')).toBe(1);

    expect(r.audit).not.toBeNull();
    expect(r.audit!.state).toBe("incomplete");
    // No rule is claimed as delivered by identity: the floor rode as a pre-rendered block, and a
    // block cannot say which versions are inside it. Honest under-claiming, not silence.
    expect(r.audit!.delivered).toEqual([]);

    // The delivery receipt SEES the degradation. This is the case the old cache-derived receipt
    // could not tell apart from a healthy turn: same cache, same bundle, same floorRulesXml field,
    // and the only difference is what actually reached the model. `scopedRules: 0` next to
    // `floorRules: 1` is the whole finding, in one line, on the turn it happened.
    expectReceiptMatchesContext(r);
    expect(r.receipt!.path).toBe("assembler");
    expect(r.receipt!.delivery).toBe("emitted");
    expect(r.receipt!.degraded).toBe("delivery-incomplete");
    expect(r.receipt!.floorRules).toBe(1);
    expect(r.receipt!.scopedRules).toBe(0);
  });

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
    // The manifest identifies each delivered rule by its immutable version (acceptance 29):
    // version-scoped delivery accounting, not bare rule ids.
    expect(r.audit!.delivered).toEqual([
      { ruleId: "fm_push", tier: "floor-must", versionId: "v1" },
      { ruleId: "s_outbox", tier: "scoped-required", versionId: "v1" },
    ]);
    expect(r.audit!.omitted).toEqual([]);

    // No-append-after-assert: the delivered context is EXACTLY the byte-asserted head, so its UTF-8
    // byte length equals the count the assembler asserted under SAFE_TOTAL. Any trailing rule block
    // would break this equality.
    expect(Buffer.byteLength(ctx, "utf8")).toBe(r.audit!.bytes);

    // The healthy turn's receipt. Paired with the foreign-root case above, these two are the
    // discrimination the whole fix exists for: 1/1 here, 1/0 there, from the same cache file.
    expectReceiptMatchesContext(r);
    expect(r.receipt!.path).toBe("assembler");
    expect(r.receipt!.delivery).toBe("emitted");
    expect(r.receipt!.floorRules).toBe(1);
    expect(r.receipt!.scopedRules).toBe(1);
    expect(r.receipt!.degraded).toBeUndefined();
    expect(r.receipt!.reason).toBeUndefined();
    // Derived from the emitted STRING, so it agrees with the assembler's independent byte assert.
    expect(r.receipt!.bytes).toBe(r.audit!.bytes);
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

    // The receipt names the OTHER degradation marker. Both §6 markers are distinguishable from
    // each other and from healthy, which is what makes a detector over this file possible at all.
    expectReceiptMatchesContext(r);
    expect(r.receipt!.path).toBe("assembler");
    expect(r.receipt!.degraded).toBe("scoped-unavailable");
    expect(r.receipt!.scopedRules).toBe(0);
  });

  it("Path 2 (over-budget floor): the subcommand delivers a floor larger than SAFE_TOTAL whole, no fallback needed", async () => {
    // A global MUST larger than SAFE_TOTAL. This once tripped the base invariant: assembleContext
    // threw, the subcommand printed NOTHING, and the hook's bash fallback owned delivery. That path
    // is retired. With no harness cap to truncate an over-budget head, the assembler's budget expands
    // to hold the required floor and delivers it WHOLE, so the subcommand's own byte-asserted head
    // reaches the model and the bash fallback never runs.
    const cache = normalCache();
    // Sized FROM the live budget, never hardcoded: this fixture used to be a flat 3000 chars, which
    // silently stopped being "over-budget" the moment SAFE_TOTAL was raised past it. SAFE_TOTAL + 1000
    // keeps the required set overrunning the budget so the EXPAND path is what is under test.
    cache.floorRules = [
      { ruleId: "fm_big", versionId: "v1", text: "z".repeat(SAFE_TOTAL + 1000), strength: "MUST" },
    ];
    cache.scopedRules = [];
    const { root, home } = sandbox(cache);
    const r = await runHook({
      root,
      home,
      sessionId: "sess-bigfloor",
      prompt: "please update apps/control/outbox.ts",
    });

    expect(r.status).toBe(0);
    const ctx = r.additionalContext!;
    // The assembler rendered the oversize STRUCTURED floor whole (not the bash fallback's pre-rendered
    // XML): the giant floor text rode inside the assembler's own head (base + floor).
    expect(ctx).toContain("zzzz");
    expect(count(ctx, 'kind="static"')).toBe(1);
    expect(count(ctx, 'kind="floor-rules"')).toBe(1);
    // The bash fallback did NOT run, so its pre-rendered floor-XML sentinel never appears.
    expect(ctx).not.toContain(FLOOR_XML_SENTINEL);
    // The audit proves the REAL subcommand success path ran: normal state, overflow false, the floor
    // delivered by durable identity, and a head that intentionally EXCEEDS safeTotal because the
    // budget expanded to hold the required floor.
    expect(r.audit).not.toBeNull();
    expect(r.audit!.state).toBe("normal");
    expect(r.audit!.overflow).toBe(false);
    expect(r.audit!.delivered).toEqual([
      { ruleId: "fm_big", tier: "floor-must", versionId: "v1" },
    ]);
    expect(r.audit!.omitted).toEqual([]);
    expect(r.audit!.bytes).toBeGreaterThan(r.audit!.safeTotal);
    // No-append-after-assert: the delivered context is EXACTLY the byte-asserted head.
    expect(Buffer.byteLength(ctx, "utf8")).toBe(r.audit!.bytes);

    // One giant floor rule is still ONE bullet, and the receipt's byte count is what makes the
    // over-budget delivery legible after the fact.
    expectReceiptMatchesContext(r);
    expect(r.receipt!.floorRules).toBe(1);
    expect(r.receipt!.bytes).toBeGreaterThan(SAFE_TOTAL);
  });

  it("receipt: a cache WITH floorRulesXml that delivers ZERO floor rules is reported as missing", async () => {
    // The regression this fix exists to make visible, isolated. The cache carries a non-empty
    // `floorRulesXml` (the exact field the retired `emit_floor_receipt` jq-read to decide
    // `delivery: "emitted"`), but the assembler renders the floor from the STRUCTURED
    // `floorRules`, which is empty here. So the model receives zero floor rules while the cache
    // still advertises a floor.
    //
    // Old receipt: `{"delivery":"emitted", ...}` — indistinguishable from a healthy turn.
    // New receipt: floorRules 0, delivery missing, reason floor_empty. Falsifiable.
    const cache = normalCache();
    cache.floorRules = [];
    const { root, home } = sandbox(cache);
    const r = await runHook({
      root,
      home,
      sessionId: "sess-empty-floor",
      prompt: "please update apps/control/outbox.ts to guard the outbox invariants",
    });

    expect(r.status).toBe(0);
    const ctx = r.additionalContext!;
    // Proof the premise holds: no floor reached the model, but the scoped rule did, so this is a
    // real delivering turn rather than a hook that did nothing.
    expect(ctx).not.toContain(FLOOR_MUST_TEXT);
    expect(ctx).not.toContain('kind="floor-rules"');
    expect(ctx).toContain(SCOPED_MUST_TEXT);
    // And the cache the OLD receipt would have read still advertises a floor.
    const seeded = JSON.parse(
      fs.readFileSync(path.join(home, "workspaces", WS, "scan-cache.json"), "utf8"),
    );
    expect(seeded.floorRulesXml).toContain(FLOOR_XML_SENTINEL);

    expectReceiptMatchesContext(r);
    expect(r.receipt!.path).toBe("assembler");
    expect(r.receipt!.delivery).toBe("missing");
    expect(r.receipt!.reason).toBe("floor_empty");
    expect(r.receipt!.floorRules).toBe(0);
    expect(r.receipt!.scopedRules).toBe(1);
  });
});
