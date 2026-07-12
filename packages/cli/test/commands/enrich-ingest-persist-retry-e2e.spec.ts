import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { buildOnboardingRun, writeRunRecord } from "../../src/lib/enrichment/plan";

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
  rmSync(HOME, { recursive: true, force: true });
});

function seedCliConfig(intelUrl: string): void {
  writeFileSync(
    join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl,
      controlToken: "ik-test",
      actorUserId: "wu_test_actor",
      mlaPath: "/bin/true",
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
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true });
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
});
