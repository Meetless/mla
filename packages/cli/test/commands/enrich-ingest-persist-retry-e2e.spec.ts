import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { buildOnboardingRun, writeRunRecord } from "../../src/lib/enrichment/plan";
import { getHandledFailure, resetHandledFailure } from "../../src/lib/analytics/handled-failure";

// BLACKBOX (command-boundary) coverage for the per-document persist retry (Finding B). The
// state-machine half is pinned in test/lib/enrichment/ingest.spec.ts by injecting a Persister;
// what THIS proves is the layer that injection skips: the REAL kb-add persister in
// commands/enrich.ts (build body -> POST /internal/v1/kb/add -> zip each receipt.outcome back
// to its doc) AND the command's exit-code contract. A real local HTTP stub stands in for intel
// (only the external boundary is faked, per the testing floor); everything else is production:
// argv parsing, config load, the marker-derived workspace, a real git repo + real fs probe, the
// run record on disk, and the ingest state machine.
//
// The regression it guards: a 200 from kb-add that carries `outcome:"failed"` for a document
// (intel's kb_add appends a failed receipt and keeps going when its KB DB is briefly
// unreachable). That used to leave the scout `complete`, so resume skipped it (`already_complete`)
// and the candidate was stranded, yet `mla enrich ingest` still exited 0. Now the scout goes
// `persistence_failed` (exit 1), and a rerun re-POSTs the same doc and completes.

const HOME = mkdtempSync(join(tmpdir(), "mla-ingest-retry-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich } = enrich;
// Same reason: the analytics spool lives under MEETLESS_HOME, which config froze above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("../../src/lib/analytics/store") as typeof import("../../src/lib/analytics/store");

/**
 * The onboarding-finding rows this test appended, and only those. The spool is append-only and
 * shared by every case in the file, so each one reads from its own baseline rather than a global
 * tally a neighbour can move.
 */
function findingRows(baseline: number): Record<string, unknown>[] {
  return (store.readEvents() as unknown as Record<string, unknown>[])
    .slice(baseline)
    .filter((e) => e.event_type === "mla_onboarding_finding");
}

const WS = "ws_ingest_retry";
const RUN_ID = "run-retry-1";

// --- the intel stub ---------------------------------------------------------------------
interface Hit {
  method: string;
  path: string;
}
let server: Server;
let port: number;
let hits: Hit[] = [];
// The receipt outcome kb-add returns for the single document we send. Flip it between runs to
// simulate a transient KB-DB blip (failed) then recovery (ingested).
let addOutcome: "failed" | "ingested" | "noop_unchanged" = "failed";

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push({ method: req.method ?? "", path: u.pathname });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (u.pathname === "/internal/v1/kb/add") {
        // One receipt per document, in input order (kb_add.py iterates body.documents). We
        // only ever send one document, so a single receipt carrying `addOutcome` is faithful.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ receipts: [{ outcome: addOutcome }] }));
        return;
      }
      // Best-effort onboarding marker (only POSTed after a fully-complete run; harmless 200).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function seedCliConfig(intelUrl: string): void {
  writeFileSync(
    join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl,
      controlToken: "ik-test",
      actorUserId: "wu_test_actor",
      mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/bin/true",
    }),
  );
}

// A real git repo whose CLAUDE.md is tracked and long enough for the file-evidence probe to
// accept the candidate (the real defaultProbe checks `git ls-files` + line count).
function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(
    join(dir, "CLAUDE.md"),
    Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
}

interface IngestJson {
  ok: boolean;
  runId?: string;
  state?: {
    status: string;
    scouts: Record<string, { status: string; candidateCount?: number; error?: string }>;
  };
  outcomes?: Array<{ scout: string; persisted: number; errors: Array<{ code: string; message: string }> }>;
}

describe("mla enrich ingest: per-document persist retry (blackbox against an intel stub)", () => {
  let repoDir: string;
  let restoreCwd: () => void;
  let resultsFile: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];

  beforeEach(() => {
    seedCliConfig(`http://127.0.0.1:${port}`);
    hits = [];
    repoDir = mkdtempSync(join(tmpdir(), "mla-ingest-retry-repo-"));
    initRepo(repoDir);
    restoreCwd = bindWorkspaceMarker(repoDir, WS);

    // A valid run record on disk (self-consistent plan digest), keyed to this workspace + repo,
    // exactly as `enrich plan` would have left it. Seeding it directly keeps the test to the
    // ingest boundary under study (no scout dispatch).
    const run = buildOnboardingRun({
      runId: RUN_ID,
      workspaceId: WS,
      repositoryRoot: repoDir,
      now: "2026-07-01T00:00:00.000Z",
      documentationTargets: [],
      historyEvidence: [],
    });
    writeRunRecord(HOME, run);

    // One documentation candidate whose file evidence the real probe will accept.
    resultsFile = join(repoDir, "scout-results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        runId: RUN_ID,
        results: [
          {
            scout: "documentation",
            status: "complete",
            candidates: [
              {
                kind: "convention",
                statement: "Use 127.0.0.1 not localhost on macOS.",
                evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 5 }],
                sourceScout: "documentation",
              },
            ],
          },
        ],
      }),
    );

    out = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    // The handled-failure declaration is a process-level singleton that cli.ts resets per
    // run; these tests drive runEnrich in-process, so reset it here for the same reason.
    resetHandledFailure();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("a per-doc failed receipt makes the scout persistence_failed and exits 1 (not a silent 0)", async () => {
    addOutcome = "failed";

    const code = await runEnrich(["ingest", "--run-id", RUN_ID, "--results-file", resultsFile, "--json"]);
    const res = JSON.parse(out.join("\n")) as IngestJson;

    // It DID reach the real kb-add persister over the wire.
    expect(hits.some((h) => h.method === "POST" && h.path === "/internal/v1/kb/add")).toBe(true);

    // The scout is retryable, the run is partial, and the exit code flags it for attention.
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");
    expect(code).toBe(1);

    // ...and the exit declares WHY, so analytics can recover the reason. This exit-1 site
    // bypasses failInMode entirely (it is a bare `return needsAttention ? 1 : 0`), so it
    // used to reach classifyOutcome as an unexplained non-zero: outcome user_error,
    // error_class null. A prod workspace burned three ingest attempts here and left
    // nothing to diagnose. It is an infra fault worth a retry, not the user's error.
    expect(getHandledFailure()).toEqual({
      error_class: "scout_persistence_failed",
      outcome: "system_error",
      retryable: true,
    });
  });

  it("a rerun re-POSTs the stranded doc and completes the scout (exit 0), never skipping it", async () => {
    // Run 1: transient failure leaves documentation persistence_failed.
    addOutcome = "failed";
    const first = await runEnrich(["ingest", "--run-id", RUN_ID, "--results-file", resultsFile, "--json"]);
    expect(first).toBe(1);
    out.length = 0;
    hits = [];

    // Run 2: KB recovered. The SAME results file is re-ingested (resume). Because the scout is
    // persistence_failed (not complete), it must re-run, not short-circuit as `already_complete`.
    addOutcome = "ingested";
    const second = await runEnrich(["ingest", "--run-id", RUN_ID, "--results-file", resultsFile, "--json"]);
    const res = JSON.parse(out.join("\n")) as IngestJson;

    // The doc was actually re-sent on the retry (proves resume did not skip the failed scout).
    expect(hits.some((h) => h.method === "POST" && h.path === "/internal/v1/kb/add")).toBe(true);
    // No `already_complete` short-circuit for documentation.
    const docOutcome = (res.outcomes ?? []).find((o) => o.scout === "documentation");
    expect((docOutcome?.errors ?? []).some((e) => e.code === "already_complete")).toBe(false);
    expect(docOutcome?.persisted).toBe(1);

    // Scout completes on the retry; the run exits clean (history was never in scope here).
    expect(res.state?.scouts.documentation.status).toBe("complete");
    expect(second).toBe(0);
  });

  // The ingest half of the §9 measurement plane, at the command boundary. The unit tests pin
  // that `ingestRun` REPORTS which findings newly landed; what only this layer can prove is that
  // `mla enrich ingest` actually turns that report into a row. This is the `persisted` half of
  // the pair, so it supplies the "time to first finding" clock and the denominators for the
  // resolution-rate and carve-out-share metrics. A documentation candidate ingests here too and
  // must NOT produce one: the metrics are about the drift-finding feature, and a run that landed
  // twelve conventions and no finding has to read as zero findings.
  it("writes NO finding row for a run that landed only conventions", async () => {
    addOutcome = "ingested";
    // Its own run id: the cases above already drove RUN_ID to a completed documentation scout,
    // and a re-ingest of that id short-circuits as `already_complete`. The assertion would then
    // hold for the wrong reason (nothing was ingested at all).
    const runId = "run-conventions-only";
    writeRunRecord(
      HOME,
      buildOnboardingRun({
        runId,
        workspaceId: WS,
        repositoryRoot: repoDir,
        now: "2026-07-01T00:00:00.000Z",
        documentationTargets: [],
        historyEvidence: [],
      }),
    );
    writeFileSync(resultsFile, JSON.stringify({ ...JSON.parse(readFileSync(resultsFile, "utf8")), runId }));
    const baseline = store.readEvents().length;

    const code = await runEnrich(["ingest", "--run-id", runId, "--results-file", resultsFile, "--json"]);
    const res = JSON.parse(out.join("\n")) as IngestJson;
    expect(code).toBe(0);
    expect(res.outcomes?.find((o) => o.scout === "documentation")?.persisted).toBe(1);

    expect(findingRows(baseline)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------
// The `persisted` analytics row, driven through the real command against a real repository.
//
// Separate repo and run record from the block above because a finding needs a repository whose
// history actually contains the disagreement: a document that stated a prohibition, and a LATER
// commit that did the prohibited thing. Everything the CLI proves about a finding (the quote at
// headCommit, the blame of the quoted line, the ancestry of the rule over the change) is read
// out of this repo by the real probe, so the fixture has to be a real two-commit history.
// -----------------------------------------------------------------------------------------
describe("mla enrich ingest: the persisted finding row (design §9)", () => {
  const FIND_WS = "ws_ingest_finding";
  // A fresh run id per case: ingest persists per-run scout state, so reusing one id would make
  // the second case short-circuit as `already_complete` and assert a zero it never earned.
  let seq = 0;
  let FIND_RUN = "run-finding-0";
  const RULE = "Files under db/migrations/ must never be edited.";
  const CHANGED = "db/migrations/0007_add_index.sql";

  let repoDir: string;
  let restoreCwd: () => void;
  let resultsFile: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let baseline: number;

  const gitIn = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

  beforeEach(() => {
    seedCliConfig(`http://127.0.0.1:${port}`);
    hits = [];
    addOutcome = "ingested";
    FIND_RUN = `run-finding-${++seq}`;
    repoDir = mkdtempSync(join(tmpdir(), "mla-ingest-finding-repo-"));

    // Commit 1: the rule, and the file it governs.
    gitIn(repoDir, "init", "-q");
    writeFileSync(
      join(repoDir, "CLAUDE.md"),
      ["# Rules", "", RULE, "", ...Array.from({ length: 8 }, (_, i) => `filler ${i + 1}`)].join("\n") + "\n",
    );
    mkdirSync(join(repoDir, "db", "migrations"), { recursive: true });
    writeFileSync(join(repoDir, CHANGED), "-- v1\n");
    gitIn(repoDir, "add", "-A");
    gitIn(repoDir, "commit", "-q", "-m", "rules and the first migration");
    const ruleCommit = gitIn(repoDir, "rev-parse", "HEAD");

    // Commit 2: the change the rule forbids, landing AFTER it. The ancestry of ruleCommit over
    // this one is the whole argument the finding rests on.
    writeFileSync(join(repoDir, CHANGED), "-- v1\nCREATE INDEX ix ON t (c);\n");
    gitIn(repoDir, "add", "-A");
    gitIn(repoDir, "commit", "-q", "-m", "add an index");
    const badCommit = gitIn(repoDir, "rev-parse", "HEAD");
    expect(ruleCommit).not.toBe(badCommit);

    restoreCwd = bindWorkspaceMarker(repoDir, FIND_WS);

    writeRunRecord(
      HOME,
      buildOnboardingRun({
        runId: FIND_RUN,
        workspaceId: FIND_WS,
        repositoryRoot: repoDir,
        now: "2026-07-01T00:00:00.000Z",
        documentationTargets: [],
        headCommit: badCommit,
        historyEvidence: [
          {
            commit: badCommit,
            timestamp: "2026-07-01T00:00:00.000Z",
            subject: "add an index",
            body: "",
            changedFiles: [{ path: CHANGED, status: "M" }],
          },
        ],
      }),
    );

    // Exactly the wire shape a reconciliation scout may send: no proposedRuleKind, no
    // attribution (both are stamped by the CLI, and a candidate carrying them is rejected).
    resultsFile = join(repoDir, "scout-results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        runId: FIND_RUN,
        results: [
          {
            scout: "reconciliation",
            status: "complete",
            candidates: [
              {
                kind: "doc_code_inconsistency",
                statement: `CLAUDE.md forbids editing files under db/migrations/, and ${badCommit.slice(0, 12)} edited one.`,
                evidence: [
                  { type: "file", path: "CLAUDE.md", startLine: 3, endLine: 3 },
                  { type: "commit", commit: badCommit, path: CHANGED },
                ],
                sourceScout: "reconciliation",
                inconsistency: {
                  claimClass: "never_modify",
                  claimText: RULE,
                  claimScope: "db/migrations/",
                  divergence: { path: CHANGED, status: "M" },
                },
              },
            ],
          },
        ],
      }),
    );

    out = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
    resetHandledFailure();
    baseline = store.readEvents().length;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  async function ingest(): Promise<IngestJson> {
    const code = await runEnrich(["ingest", "--run-id", FIND_RUN, "--results-file", resultsFile, "--json"]);
    const res = JSON.parse(out.join("\n")) as IngestJson;
    // A finding that failed verification would ingest 0 candidates and this suite would then be
    // asserting the absence of a row for the wrong reason, so pin the persist first.
    expect(res.outcomes?.find((o) => o.scout === "reconciliation")?.persisted).toBe(1);
    expect(code).toBe(0);
    return res;
  }

  it("emits one persisted row per finding that newly landed, with no verdict yet", async () => {
    await ingest();

    const rows = findingRows(baseline);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(FIND_WS);
    expect(rows[0].finding_phase).toBe("persisted");
    expect(rows[0].finding_verdict).toBeNull();
    expect(rows[0].minted_rule).toBe(false);
    // Truncated identity, never the whole candidate id and never any of its content.
    expect(rows[0].finding_id).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(rows[0])).not.toContain("migrations");
  });

  it("emits NOTHING when the server deduped the document (a re-onboard restarts no clock)", async () => {
    addOutcome = "noop_unchanged";
    await ingest();
    expect(findingRows(baseline)).toHaveLength(0);
  });

  it("emits NOTHING when the document never reached the KB", async () => {
    // A failed receipt leaves the finding unpersisted and the scout retryable. A row here would
    // report a finding the operator can never open, and would start the clock on nothing.
    addOutcome = "failed";
    const code = await runEnrich(["ingest", "--run-id", FIND_RUN, "--results-file", resultsFile, "--json"]);
    expect(code).toBe(1);
    expect(findingRows(baseline)).toHaveLength(0);
  });
});
