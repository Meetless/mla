import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

import { bindWorkspaceMarker } from "./workspace-marker.helper";

// Behavioral lock for `mla kb` (T18, §5 PART C). The KB inspector is read-only.
// `summary` wraps GET /v1/debug/substrate_counts (counts per substrate). `dump`
// wraps that PLUS GET /v1/debug/ingested_sources (one row per ingested document:
// note path / id, chunk count, last ingest), so dump actually LISTS what was
// ingested instead of re-printing the same counts. These specs drive the real
// `runKb` against an in-process HTTP stub standing in for intel (the only
// external seam we mock), under a tmp MEETLESS_HOME so config + intel base URL
// resolve hermetically. The intel base URL is read per-call from cli-config.json,
// so each test can repoint it (e.g. at a dead port) by rewriting the file;
// CFG_PATH itself is frozen at import, hence the require AFTER MEETLESS_HOME.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-kb-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set so config.ts captures our tmp.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const kb = require("../../src/commands/kb") as typeof import("../../src/commands/kb");
const { runKb, parseArgs } = kb;

const COUNTS = {
  workspaceId: "ws_test",
  chunks: 308,
  chunk_fts: 308,
  graph_nodes: 42,
  graph_edges: 17,
  claims: 9,
  ops_decision_diffs: 5,
  ops_coordination_cases: 3,
  ops_relationship_candidates: 11,
  ops_workflow_audit: 7,
  outbox_pending: 0,
};

const SOURCES = {
  workspaceId: "ws_test",
  total: 2,
  sources: [
    {
      documentId: "notes/20260527-foo.md",
      parentKind: "note",
      chunkCount: 5,
      lastIngestedAt: "2026-05-27 12:00:00",
    },
    {
      documentId: "notes/20260528-bar.md",
      parentKind: "note",
      chunkCount: 3,
      lastIngestedAt: "2026-05-28 09:30:00",
    },
  ],
};

interface NextReply {
  status: number;
  body?: unknown;
  raw?: string;
}
let nextCounts: NextReply = { status: 200, body: COUNTS };
let nextSources: NextReply = { status: 200, body: SOURCES };
let lastPath = "";

let server: http.Server;
let port = 0;
let restoreCwd: () => void = () => {};

function writeCfg(intelUrl: string): void {
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl,
      controlToken: "ik-test",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );
}

function stubUrl(): string {
  return `http://127.0.0.1:${port}`;
}

function reply(res: http.ServerResponse, r: NextReply): void {
  res.writeHead(r.status, { "Content-Type": "application/json" });
  if (r.raw !== undefined) res.end(r.raw);
  else res.end(JSON.stringify(r.body ?? {}));
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await runKb(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    lastPath = url;
    if (url.includes("/v1/debug/substrate_counts")) {
      reply(res, nextCounts);
      return;
    }
    if (url.includes("/v1/debug/ingested_sources")) {
      reply(res, nextSources);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  // Folder = workspace (T1.1): `mla kb` resolves workspaceId from the nearest
  // `.meetless.json` marker. Bind ws_test at HOME and run from inside it so the
  // substrate_counts / ingested_sources queries carry workspaceId=ws_test.
  restoreCwd = bindWorkspaceMarker(HOME, "ws_test");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreCwd();
  delete process.env.MEETLESS_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  nextCounts = { status: 200, body: COUNTS };
  nextSources = { status: 200, body: SOURCES };
  lastPath = "";
  writeCfg(stubUrl());
});

describe("mla kb: arg parsing", () => {
  it("summary defaults to no json, no markdown", () => {
    expect(parseArgs(["summary"])).toEqual({ sub: "summary", json: false, markdown: false });
  });
  it("dump defaults to no json, no markdown", () => {
    expect(parseArgs(["dump"])).toEqual({ sub: "dump", json: false, markdown: false });
  });
  it("parses --json on summary", () => {
    expect(parseArgs(["summary", "--json"])).toEqual({ sub: "summary", json: true, markdown: false });
  });
  it("parses --markdown on dump", () => {
    expect(parseArgs(["dump", "--markdown"])).toEqual({ sub: "dump", json: false, markdown: true });
  });
  it("rejects an unknown subcommand", () => {
    expect(() => parseArgs(["sources"])).toThrow(/Usage/);
  });
  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["summary", "--nope"])).toThrow(/Unknown flag/);
  });
});

describe("mla kb summary", () => {
  it("renders the three buckets with honest provenance labels and a dump pointer", async () => {
    const r = await run(["summary"]);
    expect(r.code).toBe(0);
    expect(lastPath).toContain("workspaceId=ws_test");
    expect(r.stdout).toContain("Knowledge base summary (workspace: ws_test)");
    expect(r.stdout).toContain("Sources (ingested via notes/LDM pipeline):");
    expect(r.stdout).toContain("chunks (Weaviate):        308");
    expect(r.stdout).toContain("chunk_fts (lexical):      308");
    expect(r.stdout).toContain("Internalized graph (claims + relationship pipeline; not written by notes ingest):");
    expect(r.stdout).toContain("entities (nodes):         42");
    expect(r.stdout).toContain("knowledge_relations:      17");
    expect(r.stdout).toContain("claim-kind entities:      9");
    expect(r.stdout).toContain("Control read projection:");
    expect(r.stdout).toContain("decision diffs:           5");
    expect(r.stdout).toContain("coordination cases:       3");
    expect(r.stdout).toContain("relationship candidates:  11");
    expect(r.stdout).toContain("workflow audit:           7");
    expect(r.stdout).toContain("outbox pending:           0");
    expect(r.stdout).toMatch(/Run `mla kb dump` to list the ingested sources/);
  });

  it("does not fetch the per-source listing for summary", async () => {
    await run(["summary"]);
    expect(lastPath).toContain("/v1/debug/substrate_counts");
    expect(lastPath).not.toContain("/v1/debug/ingested_sources");
  });

  it("emits raw JSON counts under --json", async () => {
    const r = await run(["summary", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(COUNTS);
  });

  it("renders zeros for missing/non-numeric counts without crashing", async () => {
    nextCounts = { status: 200, body: { workspaceId: "ws_test" } };
    const r = await run(["summary"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chunks (Weaviate):        0");
    expect(r.stdout).toContain("knowledge_relations:      0");
  });
});

describe("mla kb dump", () => {
  it("lists the ingested sources in plain output", async () => {
    const r = await run(["dump"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Ingested sources (2):");
    expect(r.stdout).toContain("notes/20260527-foo.md");
    expect(r.stdout).toContain("note, 5 chunks, last ingested 2026-05-27 12:00:00");
    expect(r.stdout).toContain("notes/20260528-bar.md");
    expect(r.stdout).toContain("note, 3 chunks, last ingested 2026-05-28 09:30:00");
    // The "run dump" pointer is a summary-only nudge; in dump the listing is
    // right here, so the pointer must not tell the reader to run dump again.
    expect(r.stdout).not.toContain("Run `mla kb dump`");
  });

  it("renders markdown tables for the three count sections plus a sources table", async () => {
    const r = await run(["dump", "--markdown"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Meetless knowledge base snapshot");
    expect(r.stdout).toContain("- workspace: `ws_test`");
    expect(r.stdout).toContain("### Sources (ingested via notes/LDM pipeline)");
    expect(r.stdout).toContain("### Internalized graph (claims + relationship pipeline, not notes ingest)");
    expect(r.stdout).toContain("### Control read projection");
    expect(r.stdout).toContain("### Ingested sources (2)");
    expect(r.stdout).toContain("| substrate | count |");
    expect(r.stdout).toContain("| chunks (Weaviate) | 308 |");
    expect(r.stdout).toContain("| knowledge_relations | 17 |");
    expect(r.stdout).toContain("| decision diffs | 5 |");
    expect(r.stdout).toContain("| outbox pending | 0 |");
    expect(r.stdout).toContain("| source | kind | chunks | last ingested |");
    expect(r.stdout).toContain("| notes/20260527-foo.md | note | 5 | 2026-05-27 12:00:00 |");
    expect(r.stdout).toContain("| notes/20260528-bar.md | note | 3 | 2026-05-28 09:30:00 |");
  });

  it("renders an empty-state line when nothing has been ingested", async () => {
    nextSources = { status: 200, body: { workspaceId: "ws_test", total: 0, sources: [] } };
    const plain = await run(["dump"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("Ingested sources (0):");
    expect(plain.stdout).toContain("none yet (nothing ingested into chunk_fts for this workspace).");
    const md = await run(["dump", "--markdown"]);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("### Ingested sources (0)");
    expect(md.stdout).toMatch(/_none yet \(nothing ingested into chunk_fts for this workspace\)\._/);
  });

  it("--json emits both counts and sources, and takes precedence over --markdown", async () => {
    const r = await run(["dump", "--markdown", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ counts: COUNTS, sources: SOURCES });
  });

  it("surfaces an intel error from the per-source listing", async () => {
    nextSources = { status: 404, raw: "Not Found" };
    const r = await run(["dump"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SERVER_ENV != production|non-production/);
  });
});

describe("mla kb: errors", () => {
  it("returns 2 on a bad subcommand", async () => {
    const r = await run(["sources"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });

  it("returns 2 on an unknown flag", async () => {
    const r = await run(["summary", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Unknown flag/);
  });

  it("explains a 404 as a production intel (route unmounted)", async () => {
    nextCounts = { status: 404, raw: "Not Found" };
    const r = await run(["summary"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SERVER_ENV != production|non-production/);
  });

  it("explains a 401 as a token problem", async () => {
    nextCounts = { status: 401, raw: "Unauthorized" };
    const r = await run(["summary"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/token/i);
    expect(r.stderr).toContain("cli-config.json");
  });

  it("explains an unreachable intel and points at mla doctor", async () => {
    writeCfg("http://127.0.0.1:1");
    const r = await run(["summary"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not reachable/);
    expect(r.stderr).toMatch(/mla doctor/);
  });
});
