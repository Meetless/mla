import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseKbShowArgs } from "../../src/commands/kb_show";

// Behavioral lock for `mla kb show` against the reshaped intel detail bundle
// (kb-console re-home, notes/20260621-kb-console-rehome-two-axis.md §3.2).
//
// The detail route is now document-centric: identity + the governed-liveness
// rollup (serving / servingStatus) + the full revision chain + the head
// revision's chunk & claim rails + a unified audit timeline. Relationship edges
// (the old candidates / promoted-edge sections) moved to the Console navigation
// lane and are NOT part of this bundle, so the edge-oriented flags (--posture,
// --include-tombstoned) and the per-edge point-in-time flag (--as-of) are gone.
//
// Under test:
//   1. The re-homed route is called with ONLY `workspaceId` (no
//      revisionLimit / auditLimit / asOf knobs).
//   2. Removed flags hard-error (exit 2) with a pointer, never silently
//      fall through to a live view.
//   3. The reshaped bundle renders: serving / servingStatus, the head
//      revision's trust + provenance axes, and the claim rail.
//   4. --all lifts the client-side claim + revision truncation.

interface Run {
  code: number;
  logs: string[];
  errs: string[];
}

const BASE_CFG = {
  controlUrl: "http://127.0.0.1:3006",
  controlToken: "secret-token",
  intelUrl: "http://127.0.0.1:8100",
  mlaPath: "/usr/local/bin/mla",
  actorUserId: "u_an",
};

function writeCfg(home: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify(cfg, null, 2) + "\n",
  );
}

function revision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionId: "rev_1",
    documentId: "kbd_x",
    status: "ACTIVE",
    reviewOutcome: "ACCEPTED",
    scopeAtIngest: "PERSON",
    provenance: "external_imported",
    actorType: "import",
    rawContentHash: "raw0000000000",
    normalizedContentHash: "norm000000000",
    contentNormalizationVersion: "v1",
    externalRevisionId: null,
    redactionState: "NONE",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-07-04T00:00:00Z",
    ...over,
  };
}

function claim(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimId: `clm_${i}`,
    sourceRevisionId: "rev_1",
    ontologyRunId: "run_1",
    claimExtractionKind: "ATOMIC",
    verbatimText: `Claim number ${i} text`,
    normalizedText: null,
    groundingStatus: "GROUNDED",
    reviewOutcome: null,
    lifecycleStatus: "ACTIVE",
    startOffset: i * 10,
    endOffset: i * 10 + 5,
    createdAt: "2026-07-04T00:00:00Z",
    ...over,
  };
}

// The reshaped KbDocumentDetail bundle. `claimCount` seeds that many claims so
// the client-side preview cap (8) is exercised.
function detailResponse(
  opts: { claimCount?: number; serving?: boolean } = {},
): Record<string, unknown> {
  const claimCount = opts.claimCount ?? 3;
  return {
    document: {
      documentId: "kbd_x",
      workspaceId: "ws_x",
      ownerUserId: "u_an",
      sourceSystem: "notes",
      sourceTenantId: "an",
      externalObjectId: "notes/20260704-doctrine.md",
      scope: "PERSON",
      currentRevisionId: "rev_1",
      headGeneration: 1,
      tombstoneState: "ACTIVE",
    },
    serving: opts.serving ?? true,
    servingStatus: (opts.serving ?? true) ? "SERVING" : "NO_HEAD",
    headRevision: revision(),
    revisions: [revision()],
    chunks: [
      {
        chunkId: "chk_1",
        revisionId: "rev_1",
        runId: "run_1",
        normalizedContentHash: "norm000000000",
        startOffset: 0,
        endOffset: 120,
        normalizationVersion: "v1",
        indexedText: "First chunk of the doctrine document body.",
        createdAt: "2026-07-04T00:00:00Z",
      },
    ],
    claims: Array.from({ length: claimCount }, (_v, i) => claim(i + 1)),
    audit: [
      {
        entryKind: "REVIEW",
        actorId: "u_an",
        occurredAt: "2026-07-04T00:00:01Z",
        review: {
          reviewEventId: "rev_evt_1",
          eventSequence: 1,
          targetKind: "REVISION",
          targetId: "rev_1",
          priorOutcome: "PENDING",
          newOutcome: "ACCEPTED",
          reviewMethod: "AUTO_TRUST",
        },
        lifecycle: null,
      },
    ],
  };
}

// A jest.fn standing in for the global fetch used by intelGet. Returns a
// minimal Response (ok/status/text), the only surface lib/http's intelGet
// touches. `kbdoc:<id>` input skips the resolve call, so the detail GET is the
// only request and this single body is enough.
function mockFetch(body: string, status = 200): jest.Mock {
  return jest.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        text: async () => body,
      }) as unknown as Response,
  );
}

// Self-contained driver: set MEETLESS_HOME so config freezes CFG_PATH from the
// test home, chdir into the repo, stub global.fetch for the detail GET, then
// resetModules + require so the module graph picks up the test env. `--workspace`
// in argv short-circuits marker resolution, so no `.meetless.json` is needed.
async function runShowIn(opts: {
  home: string;
  cwd: string;
  fetchMock: jest.Mock;
  argv: string[];
}): Promise<Run> {
  const prevHome = process.env.MEETLESS_HOME;
  const prevCwd = process.cwd();
  const prevFetch = global.fetch;
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  const errSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
  try {
    process.env.MEETLESS_HOME = opts.home;
    process.chdir(opts.cwd);
    global.fetch = opts.fetchMock as unknown as typeof fetch;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/kb_show");
    const code = (await mod.runKbShow(opts.argv)) as number;
    return { code, logs, errs };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    global.fetch = prevFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("parseKbShowArgs (reshaped surface)", () => {
  it("parses the supported boolean flags", () => {
    const flags = parseKbShowArgs([
      "kbdoc:abc",
      "--json",
      "--all",
      "--audit-all",
      "--open",
    ]);
    expect(flags.input).toBe("kbdoc:abc");
    expect(flags.json).toBe(true);
    expect(flags.all).toBe(true);
    expect(flags.auditAll).toBe(true);
    expect(flags.open).toBe(true);
  });

  it("hard-errors on --as-of (removed with the edge lane)", () => {
    expect(() => parseKbShowArgs(["kbdoc:abc", "--as-of", "2026-04-10"])).toThrow(
      /--as-of/,
    );
  });

  it("hard-errors on --posture (removed with the edge lane)", () => {
    expect(() => parseKbShowArgs(["kbdoc:abc", "--posture", "LIVE"])).toThrow(
      /--posture/,
    );
  });

  it("hard-errors on --include-tombstoned (removed with the edge lane)", () => {
    expect(() => parseKbShowArgs(["kbdoc:abc", "--include-tombstoned"])).toThrow(
      /--include-tombstoned/,
    );
  });
});

describe("mla kb show (reshaped detail bundle)", () => {
  let tmp: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-show-"));
    home = path.join(tmp, "home");
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    writeCfg(home, BASE_CFG);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("calls the detail route with only workspaceId (no pagination knobs)", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse()));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x"],
    });

    expect(r.code).toBe(0);
    // kbdoc:<id> skips the resolve call: the detail GET is the only request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = decodeURIComponent(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url).toContain("/internal/v1/kb/documents/kbd_x/detail");
    expect(url).toContain("workspaceId=ws_x");
    expect(url).not.toContain("revisionLimit=");
    expect(url).not.toContain("auditLimit=");
    expect(url).not.toContain("asOf=");
  });

  it("renders the governed-liveness rollup + head revision axes", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse()));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x"],
    });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("GROUNDING");
    expect(out).toContain("serving:");
    expect(out).toContain("SERVING");
    expect(out).toContain("HEAD REVISION");
    // Trust + provenance axes are surfaced separately, never conflated.
    expect(out).toContain("trust (reviewOutcome):");
    expect(out).toContain("ACCEPTED");
    expect(out).toContain("external_imported");
  });

  it("renders the claim rail with a preview cap and a '... and N more' hint", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse({ claimCount: 12 })));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x"],
    });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("CLAIMS  (12)");
    // Default cap is 8 -> 4 remaining.
    expect(out).toContain("... and 4 more");
    // The lifecycle / trust / grounding tri-state renders per claim.
    expect(out).toContain("[ACTIVE/unreviewed/GROUNDED]");
  });

  it("--all lifts the claim preview cap (no truncation hint)", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse({ claimCount: 12 })));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x", "--all"],
    });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("CLAIMS  (12)");
    expect(out).not.toContain("... and");
  });

  it("exposes the reshaped view (serving + claims) in JSON, no edge fields", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse({ claimCount: 5 })));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x", "--json"],
    });

    expect(r.code).toBe(0);
    const view = JSON.parse(r.logs.join("\n"));
    expect(view.serving).toBe(true);
    expect(view.servingStatus).toBe("SERVING");
    expect(view.claims.totalCount).toBe(5);
    expect(view.headRevision.reviewOutcome).toBe("ACCEPTED");
    // Edges are gone: no candidate / promoted sections leak into the view.
    expect(view.candidates).toBeUndefined();
    expect(view.promoted).toBeUndefined();
  });

  it("renders a NOT-serving posture honestly", async () => {
    const body = detailResponse({ serving: false });
    (body as Record<string, unknown>).headRevision = null;
    const fetchMock = mockFetch(JSON.stringify(body));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x"],
    });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("serving:");
    expect(out).toContain("NO");
    expect(out).toContain("NO_HEAD");
    expect(out).toContain("no activated head");
  });

  it("exits 2 on a removed flag without ever calling the endpoint", async () => {
    const fetchMock = mockFetch(JSON.stringify(detailResponse()));
    const r = await runShowIn({
      home,
      cwd: repo,
      fetchMock,
      argv: ["kbdoc:kbd_x", "--workspace", "ws_x", "--as-of", "2026-04-10"],
    });

    expect(r.code).toBe(2);
    // A removed flag must never silently fall through to a live view.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
