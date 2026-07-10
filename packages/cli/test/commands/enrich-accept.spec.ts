// test/commands/enrich-accept.spec.ts
//
// Coverage for `mla enrich accept`: the command that closes the loop the onboarding
// investigation found. `enrich ingest` parks a run's merged candidates in a per-run
// sidecar; `enrich accept` reads that sidecar and materializes the DURABLE ones
// (constraint, convention, boundary) into `.meetless/rules.md`, leaving decisions and
// deprecations to the governed Console KB. Two layers are pinned here:
//   - the pure argument parser + review renderer (fast, no fs);
//   - the real command boundary end to end: a real sidecar under a throwaway HOME, a real
//     git repo, and the real materializeRules bridge writing (or not writing) the file.
// No internal service is mocked; only console is spied to capture output.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts freezes HOME at module load, so MEETLESS_HOME must be set BEFORE the command
// module is required (same pattern as enrich-workspace-gate.spec.ts).
const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-accept-home-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich, parseAcceptArgs, renderAcceptReview } = enrich;

import { upsertCandidatesSidecar } from "../../src/lib/enrichment/ingest";
import { MANAGED_RULES_PATH } from "../../src/lib/scanner/managed-rules";
import type {
  EnrichmentKind,
  OnboardingCandidateRecord,
  OnboardingCandidatesSidecar,
} from "../../src/lib/enrichment/protocol";

const WS = "ws_enrich_accept";

function rec(candidateId: string, kind: EnrichmentKind, statement: string): OnboardingCandidateRecord {
  return {
    candidateId,
    kind,
    statement,
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
    sourceScouts: ["documentation"],
    rationale: null,
    rationaleSource: null,
    relPath: `onboarding/${candidateId}-x.md`,
    landed: "ingested",
  };
}

// ---------------------------------------------------------------------------------------
// Pure layer: parseAcceptArgs + renderAcceptReview (no fs, no HOME needed).
// ---------------------------------------------------------------------------------------
describe("parseAcceptArgs", () => {
  it("requires --run-id (missing entirely) ", () => {
    expect(() => parseAcceptArgs([])).toThrow(/--run-id is required/);
  });

  it("requires a value for --run-id", () => {
    expect(() => parseAcceptArgs(["--run-id"])).toThrow(/--run-id requires a value/);
  });

  it("parses the bare (review) form: run-id only, no selection", () => {
    const f = parseAcceptArgs(["--run-id", "run_abc"]);
    expect(f).toEqual({ runId: "run_abc", all: false, dryRun: false, json: false });
  });

  it("parses --all, --dry-run, --json, --workspace", () => {
    const f = parseAcceptArgs(["--run-id", "run_abc", "--all", "--dry-run", "--json", "--workspace", "ws_1"]);
    expect(f).toMatchObject({ runId: "run_abc", all: true, dryRun: true, json: true, workspace: "ws_1" });
  });

  it("--all and --only are mutually exclusive", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--all", "--only", "a1b2c3"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("lowercases and trims --only prefixes", () => {
    const f = parseAcceptArgs(["--run-id", "r", "--only", " A1B2C3 , d4e5f6 "]);
    expect(f.only).toEqual(["a1b2c3", "d4e5f6"]);
  });

  it("rejects an --only prefix shorter than 6 hex chars", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", "a1b2c"])).toThrow(
      /at least 6 hex characters/,
    );
  });

  it("rejects a non-hex --only prefix (a typo can never be read as an id)", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", "zzzzzz"])).toThrow(
      /at least 6 hex characters/,
    );
  });

  it("requires at least one prefix for --only", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", " , "])).toThrow(/at least one candidate id prefix/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--promote"])).toThrow(/Unknown flag/);
  });
});

describe("renderAcceptReview", () => {
  const durable = [
    rec("b2b2b2b2b2b2", "convention", "Prefer relative imports."),
    rec("a1a1a1a1a1a1", "constraint", "Use 127.0.0.1, not localhost, on macOS."),
  ];
  const knowledge = [rec("d4d4d4d4d4d4", "decision", "We picked Cloud Run over a VM.")];

  it("lists durable rules sorted by statement with a 12-char id and [kind]", () => {
    const text = renderAcceptReview(durable, knowledge);
    expect(text).toMatch(/2 durable rules this run found \(accept to materialize into \.meetless\/rules\.md\):/);
    // Sorted by statement: "Prefer relative imports." precedes "Use 127.0.0.1...".
    expect(text.indexOf("Prefer relative imports.")).toBeLessThan(text.indexOf("Use 127.0.0.1"));
    expect(text).toContain("a1a1a1a1a1a1  [constraint]  Use 127.0.0.1, not localhost, on macOS.");
    expect(text).toContain("b2b2b2b2b2b2  [convention]  Prefer relative imports.");
  });

  it("lists governed-knowledge candidates separately and marks them NOT materialized", () => {
    const text = renderAcceptReview(durable, knowledge);
    expect(text).toMatch(/1 governed-knowledge candidate \(NOT materialized; governed in the Console KB\):/);
    expect(text).toContain("d4d4d4d4d4d4  [decision]  We picked Cloud Run over a VM.");
  });

  it("shows the --all / --only / --dry-run hints when there are durable rules", () => {
    const text = renderAcceptReview(durable, knowledge);
    expect(text).toContain("--all");
    expect(text).toContain("--only");
    expect(text).toContain("--dry-run");
  });

  it("says nothing to materialize (and omits hints) when there are no durable rules", () => {
    const text = renderAcceptReview([], knowledge);
    expect(text).toMatch(/This run found no durable rules to materialize into \.meetless\/rules\.md\./);
    expect(text).not.toContain("--all");
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    const text = renderAcceptReview(durable, knowledge);
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/ -- /);
  });
});

// ---------------------------------------------------------------------------------------
// Command boundary end to end: real sidecar, real git repo, real materialize.
// ---------------------------------------------------------------------------------------
describe("mla enrich accept (end to end, real sidecar + file write)", () => {
  let repo: string;
  let root: string; // git toplevel (realpath); the command writes relative to the sidecar's repositoryRoot
  let managedPath: string;
  let cwd0: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];

  const RUN = "run_accept_e2e";

  beforeAll(() => {
    // A minimal cli-config so readKbConfig resolves an actor without a marker; --workspace
    // supplies the workspaceId directly (admin override), so no `.meetless.json` is needed.
    writeFileSync(
      join(HOME, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: "http://127.0.0.1:1",
        controlToken: "ik-test",
        actorUserId: "user_test",
        mlaPath: "/bin/true",
      }),
    );
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-enrich-accept-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
    managedPath = join(root, MANAGED_RULES_PATH);
    cwd0 = process.cwd();
    process.chdir(repo);
    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m ?? "")));
    errSpy = jest.spyOn(console, "error").mockImplementation((m?: unknown) => void err.push(String(m ?? "")));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(cwd0);
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
  });

  function seed(runId: string, candidates: OnboardingCandidateRecord[]): void {
    const sidecar: OnboardingCandidatesSidecar = {
      schemaVersion: 1,
      workspaceId: WS,
      runId,
      repositoryRoot: root,
      updatedAt: "2026-07-10T00:00:00.000Z",
      candidates,
    };
    upsertCandidatesSidecar(HOME, sidecar);
  }

  // The mixed run every selection test reuses: 3 durable kinds + 2 governed-knowledge kinds.
  function seedMixed(): void {
    seed(RUN, [
      rec("a1a1a1a1a1a1a1a1", "constraint", "Use 127.0.0.1, not localhost, on macOS."),
      rec("b2b2b2b2b2b2b2b2", "convention", "Prefer relative imports."),
      rec("c3c3c3c3c3c3c3c3", "boundary", "control owns the state machine."),
      rec("d4d4d4d4d4d4d4d4", "decision", "We picked Cloud Run over a VM."),
      rec("e5e5e5e5e5e5e5e5", "deprecation", "apps/api is decommissioned."),
    ]);
  }

  it("exits 2 with a helpful message when no sidecar exists for the run", async () => {
    const code = await runEnrich(["accept", "--run-id", "run_missing", "--workspace", WS]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no candidates sidecar for run run_missing/);
    expect(err.join("\n")).toMatch(/Run `mla enrich ingest` first/);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("review mode (no selection flag) writes nothing and shows durable + governed-knowledge", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false); // read-only
    const text = out.join("\n");
    expect(text).toMatch(/3 durable rules this run found/);
    expect(text).toContain("Use 127.0.0.1, not localhost, on macOS.");
    expect(text).toMatch(/2 governed-knowledge candidates \(NOT materialized/);
    expect(text).toContain("We picked Cloud Run over a VM.");
  });

  it("--all materializes the 3 durable rules and skips the 2 governed-knowledge ones (kind split)", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS]);
    expect(code).toBe(0);
    // review printed above did not write; now accept for real:
    const code2 = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all"]);
    expect(code2).toBe(0);
    expect(existsSync(managedPath)).toBe(true);
    const file = readFileSync(managedPath, "utf8");
    expect(file).toContain("Use 127.0.0.1, not localhost, on macOS."); // constraint
    expect(file).toContain("Prefer relative imports."); // convention
    expect(file).toContain("control owns the state machine."); // boundary
    // The governed-knowledge kinds never reach the managed file.
    expect(file).not.toContain("We picked Cloud Run over a VM."); // decision
    expect(file).not.toContain("apps/api is decommissioned."); // deprecation
    expect(out.join("\n")).toMatch(/Skipped 2 non-rule candidate/);
  });

  it("INV-AUTH-2: --all writes NOTHING when the run found only governed-knowledge kinds", async () => {
    seed(RUN, [
      rec("d4d4d4d4d4d4d4d4", "decision", "We chose Postgres SKIP LOCKED over SQS."),
      rec("e5e5e5e5e5e5e5e5", "deprecation", "agent is superseded by intel."),
    ]);
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all"]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(out.join("\n")).toMatch(/No durable rules to materialize/);
  });

  it("--only <prefix> materializes just the matched candidate", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--only", "a1a1a1"]);
    expect(code).toBe(0);
    const file = readFileSync(managedPath, "utf8");
    expect(file).toContain("Use 127.0.0.1, not localhost, on macOS.");
    expect(file).not.toContain("Prefer relative imports.");
    expect(file).not.toContain("control owns the state machine.");
  });

  it("--only is fail-closed on a zero-match prefix (exit 2, no write)", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--only", "999999"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no candidate id starts with "999999"/);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("--only is fail-closed on an ambiguous prefix (exit 2, no write)", async () => {
    seed(RUN, [
      rec("abcdef111111", "constraint", "First colliding rule."),
      rec("abcdef222222", "convention", "Second colliding rule."),
    ]);
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--only", "abcdef"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/prefix "abcdef" is ambiguous/);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("--dry-run --all previews the change without writing", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all", "--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(out.join("\n")).toMatch(/Would materialize 3 durable rule/);
    expect(out.join("\n")).not.toMatch(/Effective locally/);
  });

  it("--json --all reports the machine shape (wrote true, skipped count)", async () => {
    seedMixed();
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.runId).toBe(RUN);
    expect(parsed.path).toBe(MANAGED_RULES_PATH);
    expect(parsed.changed).toBe(true);
    expect(parsed.wrote).toBe(true);
    expect(parsed.materialized).toHaveLength(3);
    // skipped is the array of skip records (kind/reason/statement), not a count.
    expect(parsed.skipped).toHaveLength(2);
    expect(parsed.skipped.map((s: { kind: string }) => s.kind).sort()).toEqual(["decision", "deprecation"]);
  });

  it("is byte-idempotent: re-accepting --all does not change the file", async () => {
    seedMixed();
    await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all"]);
    const first = readFileSync(managedPath, "utf8");
    const code = await runEnrich(["accept", "--run-id", RUN, "--workspace", WS, "--all"]);
    expect(code).toBe(0);
    expect(readFileSync(managedPath, "utf8")).toBe(first);
  });
});
