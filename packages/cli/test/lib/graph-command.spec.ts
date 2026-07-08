// Behavioral lock for `mla graph` — the coordination-graph (relationship) surface.
//
// Why this command exists (notes/20260608-mla-ml-generalization-review.md, Q1):
// `mla kb` had quietly grown to cover TWO orthogonal axes:
//   (a) document / posture: ingestion + grounding (LIVE vs SHADOW) — add, show,
//       reingest, forget, purge, move, retime, promote, personal, summary, dump.
//   (b) relationship / graph: typed edges between docs decided via verdicts —
//       review, pending.
// Calling axis (b) "kb" buries the coordination graph (the product's actual
// substrate) under a storage noun. `mla graph` gives axis (b) its own home WITHOUT
// moving axis (a). It is a thin re-home: `review`/`pending` route to the exact same
// handlers as `mla kb review`/`mla kb pending`, so there is one implementation, two
// entry points. `kb review`/`kb pending` stay as working back-compat aliases.
//
// These tests pin: (1) the usage screen teaches the two-axes separation, (2) the
// router delegates review/pending to the relationship handlers with the SAME
// overload + pending-alias semantics as kb, and (3) typing a document/posture verb
// under `graph` gets a POINTED redirect to `mla kb` (the anti-conflation guardrail
// made executable), not a generic "unknown subcommand".

// Mock the two relationship-review handlers so these tests exercise ROUTING
// (graph's job), not the handlers themselves (covered by their own specs). The
// handlers reach the network; the router does not.
jest.mock("../../src/commands/kb_pending", () => ({
  runKbReviewList: jest.fn(async () => 0),
}));
jest.mock("../../src/commands/kb_review", () => ({
  runKbReview: jest.fn(async () => 0),
}));

import { runGraph } from "../../src/commands/graph";
import { runKbReviewList } from "../../src/commands/kb_pending";
import { runKbReview } from "../../src/commands/kb_review";

const listMock = runKbReviewList as jest.Mock;
const verdictMock = runKbReview as jest.Mock;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  const errSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...a) => void err.push(a.map(String).join(" ")));
  try {
    const code = await runGraph(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

beforeEach(() => {
  listMock.mockClear();
  verdictMock.mockClear();
  listMock.mockResolvedValue(0);
  verdictMock.mockResolvedValue(0);
});

describe("mla graph: usage screen", () => {
  it.each([[], ["help"], ["--help"], ["-h"]])(
    "`mla graph %s` prints the catalog to stdout and exits 0",
    async (...argv) => {
      const r = await run(argv as string[]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/mla graph:/);
      expect(r.stdout).toMatch(/relationship/i);
      // It must not leak onto the error stream.
      expect(r.stderr).toBe("");
      // Help is read-only: it never reaches the relationship handlers.
      expect(listMock).not.toHaveBeenCalled();
      expect(verdictMock).not.toHaveBeenCalled();
    },
  );

  it("teaches the two-axes separation and points doc/posture work at `mla kb`", async () => {
    const r = await run([]);
    // The whole point of the command: name the other axis and where it lives.
    expect(r.stdout).toMatch(/posture/i);
    expect(r.stdout).toMatch(/mla kb/);
    // The four edge types are the graph axis's vocabulary.
    expect(r.stdout).toMatch(/SUPERSEDES/);
    expect(r.stdout).toMatch(/CONTRADICTS/);
  });

  it("advertises the canonical relationship verbs under the graph noun", async () => {
    const r = await run(["help"]);
    expect(r.stdout).toMatch(/mla graph review/);
    expect(r.stdout).toMatch(/mla graph pending/);
  });
});

describe("mla graph review: routing (delegates to the same handlers as `kb review`)", () => {
  it("with no args lists the queue (current-session default, list mode)", async () => {
    const r = await run(["review"]);
    expect(r.code).toBe(0);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith([]);
    expect(verdictMock).not.toHaveBeenCalled();
  });

  it("with a leading flag stays in list mode and forwards the flags verbatim", async () => {
    await run(["review", "--all"]);
    expect(listMock).toHaveBeenCalledWith(["--all"]);
    expect(verdictMock).not.toHaveBeenCalled();
  });

  it("--session and --json pass straight through to the list handler", async () => {
    await run(["review", "--session", "current", "--json"]);
    expect(listMock).toHaveBeenCalledWith(["--session", "current", "--json"]);
  });

  it("with a leading candidate id records a verdict (verdict mode)", async () => {
    await run(["review", "cand_abc123", "--accept"]);
    expect(verdictMock).toHaveBeenCalledTimes(1);
    expect(verdictMock).toHaveBeenCalledWith(["cand_abc123", "--accept"]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("propagates the handler's exit code", async () => {
    verdictMock.mockResolvedValue(2);
    const r = await run(["review", "cand_abc123", "--accept"]);
    expect(r.code).toBe(2);
  });
});

describe("mla graph pending: deprecated alias for `graph review` (list)", () => {
  it("injects --all when no explicit scope is given (preserves old workspace-wide default)", async () => {
    await run(["pending"]);
    expect(listMock).toHaveBeenCalledWith(["--all"]);
  });

  it("does NOT inject --all when a scope is already present", async () => {
    await run(["pending", "--doc", "kbdoc:1"]);
    expect(listMock).toHaveBeenCalledWith(["--doc", "kbdoc:1"]);
  });
});

describe("mla graph: anti-conflation guardrail", () => {
  // The central warning of the review: do not let the two axes blur. Typing a
  // document/posture verb under `graph` must not fall through to a generic error;
  // it must redirect to the kb surface that owns that axis.
  it.each([
    "add",
    "show",
    "reingest",
    "forget",
    "purge",
    "move",
    "retime",
    "promote",
    "personal",
    "summary",
    "dump",
  ])("redirects the document/posture verb `%s` to `mla kb`", async (verb) => {
    const r = await run([verb, "whatever"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`mla kb ${verb}`));
    // It explains WHY (axis mismatch), not just "unknown".
    expect(r.stderr).toMatch(/posture|document|grounding/i);
    // A misrouted doc verb must never touch the relationship handlers.
    expect(listMock).not.toHaveBeenCalled();
    expect(verdictMock).not.toHaveBeenCalled();
  });

  it("never ships `graph add` as an ingest path (the explicit trap from the review)", async () => {
    const r = await run(["add", "./some/file.md"]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toMatch(/ingest/i);
    expect(r.stderr).toMatch(/mla kb add/);
  });
});

describe("mla graph: unknown subcommand", () => {
  it("returns 2 and re-emits the catalog on stderr", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/mla graph:/);
    expect(r.stderr).toMatch(/unknown/i);
    expect(listMock).not.toHaveBeenCalled();
    expect(verdictMock).not.toHaveBeenCalled();
  });
});
