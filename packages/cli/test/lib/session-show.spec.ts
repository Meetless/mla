import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

import { bindWorkspaceMarker } from "./workspace-marker.helper";

// Plane 3 behavioral lock for `mla session show` (notes/20260528-mla-logging-
// and-tracing-proposal.md §2.5, §6.B, principle 6+7). Pinned invariants:
//
//   I1  Resolution ladder is positional -> $SESSION_ID -> fail. There is NO
//       workspace-latest fallback: `mla` must bind to its CURRENT session and
//       must never be ABLE to resolve to another session's run (dogfood
//       directive 2026-05-31). The first line printed MUST announce
//       "Session: <sid> (source: <positional|env>)" so a stale env is NEVER
//       silent. The CLI must NOT call GET /agent-runs/latest at all.
//   I2  --json envelope shape is fixed:
//          { sessionId, externalSessionId, runId, source, truncated,
//            nextCursor, totalReturned, displayed, events: [...] }
//       displayed == events.length, totalReturned >= displayed.
//   I3  Redaction is unconditional and lives BELOW the format boundary:
//       --json output for an event whose payload carries a fake
//       `ghp_<entropy>` token must NOT contain the raw token. Defense-in-
//       depth: even if the in-process stub forgets to redact, the CLI's
//       redactPayload pass at the render boundary still scrubs it.
//   I4  --last N tails the chronological feed (last N of M with M>N) and
//       announces "(showing last N of M events)"; pagination is followed to
//       completion before the tail slice.
//   I5  404 from the events endpoint maps to a friendly "No agent run found
//       for session <sid> in this workspace" error, exit code 1, NEVER an
//       unhandled throw.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-session-show-"));
process.env.MEETLESS_HOME = HOME;

// require AFTER MEETLESS_HOME so config.ts captures the tmp dir.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const session = require("../../src/commands/session") as typeof import("../../src/commands/session");
const { runSessionShow, parseShowArgs } = session;

interface Reply {
  status: number;
  body?: unknown;
  raw?: string;
}

interface EventRow {
  id: string;
  // Field name pinned to the server contract (AgentRunService.getEventsBySession
  // returns `eventType`). Earlier drafts used `type:` here, which masked a
  // production render-as-undefined bug in the CLI. Do NOT rename without
  // updating the service response shape AND the CLI's AgentRunEventView.
  eventType: string;
  occurredAt: string;
  payload: unknown;
}

let server: http.Server;
let port = 0;
let restoreCwd: () => void = () => {};
let latestReply: Reply | null = null;
let latestHit = false; // set true if the CLI ever calls /agent-runs/latest
let eventPages: Map<string, Reply> = new Map(); // key = cursor || "FIRST"
let lastEventsQuery = "";
let receivedAuth = "";

function stubUrl(): string {
  return `http://127.0.0.1:${port}`;
}

function writeCfg(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: stubUrl(),
      intelUrl: stubUrl(),
      controlToken: "ik-test",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
      ...overrides,
    }),
  );
}

function sendReply(res: http.ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { "Content-Type": "application/json" });
  if (reply.raw !== undefined) res.end(reply.raw);
  else res.end(JSON.stringify(reply.body ?? {}));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    receivedAuth = (req.headers["authorization"] as string) || "";
    const url = req.url ?? "";
    if (url.startsWith("/internal/v1/agent-runs/latest")) {
      latestHit = true;
      if (latestReply) sendReply(res, latestReply);
      else {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    const m = url.match(/^\/internal\/v1\/agent-runs\/by-session\/([^/]+)\/events(?:\?(.*))?$/);
    if (m) {
      lastEventsQuery = m[2] ?? "";
      const params = new URLSearchParams(lastEventsQuery);
      const cursor = params.get("cursor");
      const key = cursor ?? "FIRST";
      const reply = eventPages.get(key);
      if (reply) sendReply(res, reply);
      else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "not found" }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  // Folder = workspace (T1.1): `mla session show` resolves workspaceId from the
  // nearest `.meetless.json` marker. Bind ws_test at HOME and run from inside it
  // so the events query carries workspaceId=ws_test.
  restoreCwd = bindWorkspaceMarker(HOME, "ws_test");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreCwd();
  delete process.env.MEETLESS_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  latestReply = null;
  latestHit = false;
  eventPages = new Map();
  lastEventsQuery = "";
  receivedAuth = "";
  // Clear BOTH so each test controls the env explicitly. CLAUDE_CODE_SESSION_ID
  // is set in this very test process (jest runs inside a live Claude Code
  // session), so it MUST be cleared or the no-env failure case would pick it up.
  // SESSION_ID is the legacy var that nothing sets anymore; kept here only to
  // prove it is now IGNORED.
  delete process.env.SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  writeCfg();
});

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
    const code = await runSessionShow(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function makeEvents(prefix: string, n: number, startTs = "2026-05-29T10:00:00.000Z"): EventRow[] {
  const base = Date.parse(startTs);
  return Array.from({ length: n }, (_, i) => ({
    id: `evt-${prefix}-${i}`,
    eventType: "prompt_submitted",
    occurredAt: new Date(base + i * 1000).toISOString(),
    payload: { prompt: `step ${i}` },
  }));
}

function pageReply(events: EventRow[], nextCursor: string | null, truncated: boolean): Reply {
  return {
    status: 200,
    body: {
      sessionId: "sess-show",
      externalSessionId: "sess-show",
      runId: "run-7",
      events,
      truncated,
      nextCursor,
    },
  };
}

describe("parseShowArgs", () => {
  it("accepts a bare sid", () => {
    expect(parseShowArgs(["sess-1"])).toEqual({ sessionId: "sess-1", json: false });
  });
  it("accepts --json and --last together", () => {
    expect(parseShowArgs(["sess-1", "--json", "--last", "5"])).toEqual({
      sessionId: "sess-1",
      json: true,
      last: 5,
    });
  });
  it("rejects --last without a value", () => {
    expect(() => parseShowArgs(["--last"])).toThrow(/--last requires a positive integer/);
  });
  it("rejects --last 0 (clamped to positive)", () => {
    expect(() => parseShowArgs(["--last", "0"])).toThrow(/positive integer/);
  });
  it("rejects --last with a non-number", () => {
    expect(() => parseShowArgs(["--last", "lots"])).toThrow(/positive integer/);
  });
  it("rejects unknown flags", () => {
    expect(() => parseShowArgs(["--foo"])).toThrow(/Unknown flag/);
  });
  it("rejects a second positional", () => {
    expect(() => parseShowArgs(["a", "b"])).toThrow(/Expected at most one/);
  });
});

describe("mla session show: I1 resolution ladder", () => {
  it("positional sid wins; latest endpoint is never called", async () => {
    // Wire latest to a different sid; if the CLI reaches it we'd see "alt".
    latestReply = { status: 200, body: { externalSessionId: "alt-sid", sessionId: "alt-sid" } };
    eventPages.set("FIRST", pageReply(makeEvents("p", 2), null, false));
    const r = await run(["sess-show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Session: sess-show (source: positional)");
    // The events query must have hit the positional sid path, not "alt-sid".
    expect(lastEventsQuery).toContain("workspaceId=ws_test");
    expect(r.stdout).not.toContain("alt-sid");
    expect(latestHit).toBe(false);
  });

  it("$CLAUDE_CODE_SESSION_ID wins when no positional sid is given; latest is never called", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "env-sid";
    eventPages.set("FIRST", pageReply([{ id: "e", eventType: "prompt_submitted", occurredAt: "2026-05-29T10:00:00.000Z", payload: { prompt: "x" } }], null, false));
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Session: env-sid (source: env)");
    expect(latestHit).toBe(false);
  });

  it("IGNORES the legacy $SESSION_ID var (only CLAUDE_CODE_SESSION_ID is honored)", async () => {
    // SESSION_ID used to be the env fallback, but nothing exports it (Claude
    // Code sets CLAUDE_CODE_SESSION_ID). Consolidated 2026-05-31: setting only
    // the old var must NOT resolve a session -- the command fails like no-env.
    process.env.SESSION_ID = "legacy-sid";
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("legacy-sid");
    expect(latestHit).toBe(false);
    expect(r.stderr).toMatch(/no session id/i);
  });

  it("FAILS (exit 1) when neither positional nor env is set; NEVER resolves to workspace-latest", async () => {
    // The session-only directive: with no current session to bind to, the CLI
    // must refuse rather than reach for another session's run. Even if a
    // workspace-latest run exists, it must NOT be consulted.
    latestReply = { status: 200, body: { externalSessionId: "some-other-sid", sessionId: "some-other-sid" } };
    const r = await run([]);
    expect(r.code).toBe(1);
    expect(latestHit).toBe(false); // the cross-session resolver was never called
    expect(r.stdout).not.toContain("some-other-sid");
    expect(r.stderr).toMatch(/no session id/i);
    expect(r.stderr).toMatch(/mla session show <sid>/);
  });

  it("sends Bearer token to the events endpoint (header parity with hook)", async () => {
    eventPages.set("FIRST", pageReply(makeEvents("p", 1), null, false));
    await run(["sess-show"]);
    expect(receivedAuth).toBe("Bearer ik-test");
  });
});

describe("mla session show: I2 --json envelope shape", () => {
  it("emits the pinned envelope keys with displayed == events.length", async () => {
    eventPages.set("FIRST", pageReply(makeEvents("p", 3), null, false));
    const r = await run(["sess-show", "--json"]);
    expect(r.code).toBe(0);
    // In --json mode the announce line MUST live on stderr so stdout stays a
    // clean parseable JSON document (pipeable into jq / a file). If a future
    // refactor re-routes the announce to stdout, JSON.parse below blows up.
    const parsed = JSON.parse(r.stdout);
    expect(r.stderr).toContain("Session: sess-show (source: positional)");
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "displayed",
        "events",
        "externalSessionId",
        "nextCursor",
        "runId",
        "sessionId",
        "source",
        "totalReturned",
        "truncated",
      ].sort(),
    );
    expect(parsed.sessionId).toBe("sess-show");
    expect(parsed.externalSessionId).toBe("sess-show");
    expect(parsed.runId).toBe("run-7");
    expect(parsed.source).toBe("positional");
    expect(parsed.events).toHaveLength(3);
    expect(parsed.totalReturned).toBe(3);
    expect(parsed.displayed).toBe(parsed.events.length);
    expect(parsed.truncated).toBe(false);
    expect(parsed.nextCursor).toBeNull();
  });

  it("surfaces server truncation to stderr in --json mode", async () => {
    eventPages.set(
      "FIRST",
      pageReply(makeEvents("p", 100), null, /* truncated */ true),
    );
    const r = await run(["sess-show", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/server cap clipped/);
  });
});

describe("mla session show: I3 redaction parity (defense in depth)", () => {
  it("scrubs a provider token from --json output even if the server returns it raw", async () => {
    // The CLI's redactPayload pass at the render boundary is the belt-and-
    // suspenders defense for principle 7. If a server bug ever lets a raw
    // ghp_<entropy> token through, the operator's terminal/file output must
    // STILL be clean. We deliberately ship the raw token from the stub.
    const ghToken = "ghp_" + "ABCDEFGHIJKLMNOPQRST"; // 24 chars after ghp_
    eventPages.set("FIRST", pageReply(
      [{
        id: "e1",
        eventType: "tool_used_bash",
        occurredAt: "2026-05-29T10:00:00.000Z",
        payload: { command: `curl -H "Authorization: token ${ghToken}" api.github.com`, exitCode: 0 },
      }],
      null,
      false,
    ));
    const r = await run(["sess-show", "--json"]);
    expect(r.code).toBe(0);
    // Sanity: the raw token MUST not appear anywhere in operator-visible output.
    expect(r.stdout).not.toContain(ghToken);
    expect(r.stdout).toContain("[REDACTED]");
  });

  it("scrubs the same provider token from human render output", async () => {
    const skToken = "sk-ant-api03-" + "abcdefghijklmnopqrstuvwxyz0123";
    eventPages.set("FIRST", pageReply(
      [{
        id: "e1",
        eventType: "tool_used_bash",
        occurredAt: "2026-05-29T10:00:00.000Z",
        payload: { command: `export ANTHROPIC_API_KEY=${skToken}`, exitCode: 0 },
      }],
      null,
      false,
    ));
    const r = await run(["sess-show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(skToken);
    expect(r.stdout).toContain("[REDACTED]");
  });
});

describe("mla session show: I4 --last N tail", () => {
  it("shows the last N of M events with an announce line and follows pagination first", async () => {
    // Page 1: 3 events, nextCursor set. Page 2: 2 events, no nextCursor.
    // Total = 5, request --last 2, displayed = 2 (the final two by occurredAt).
    const p1 = makeEvents("p1", 3, "2026-05-29T10:00:00.000Z");
    const p2 = makeEvents("p2", 2, "2026-05-29T10:01:00.000Z");
    eventPages.set("FIRST", pageReply(p1, "CURSOR_A", false));
    eventPages.set("CURSOR_A", pageReply(p2, null, false));
    const r = await run(["sess-show", "--last", "2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(showing last 2 of 5 events)");
    // The earlier-event ids must NOT appear in the human output once tailed.
    expect(r.stdout).not.toContain("evt-p1-0");
    expect(r.stdout).not.toContain("evt-p1-1");
    // The tail-displayed timestamps from p2 must appear.
    expect(r.stdout).toContain(p2[0].occurredAt);
    expect(r.stdout).toContain(p2[1].occurredAt);
  });

  it("when --last exceeds total, shows the totals line and all events", async () => {
    eventPages.set("FIRST", pageReply(makeEvents("p", 2), null, false));
    const r = await run(["sess-show", "--last", "999"]);
    expect(r.code).toBe(0);
    // --last >= total falls through to the totals line, not the tail line.
    expect(r.stdout).toContain("(2 event(s) captured)");
    expect(r.stdout).not.toMatch(/showing last 999/);
  });

  it("prints (no events captured) when the session has zero allowlisted events", async () => {
    eventPages.set("FIRST", pageReply([], null, false));
    const r = await run(["sess-show"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Session: sess-show (source: positional)");
    expect(r.stdout).toContain("(no events captured for this session)");
  });
});

// I6 pins the client-side page-budget (SHOW_MAX_PAGES = 50) so a runaway feed
// never silently dumps a partial capture as if it were complete. The bug we
// regression-guard: the post-loop guard previously checked a loop-local
// `cursor` that goes stale when the final page exits via break-before-advance.
// On a session that finishes at EXACTLY the page-budget edge with no more
// pages, that stale cursor wrongly tripped the truncation warning and
// overwrote nextCursor=null with the next-to-last cursor.
describe("mla session show: I6 client page budget", () => {
  function primeCursorPages(pageCount: number, lastPageEndsFeed: boolean): void {
    // Pages 1..pageCount-1 always carry forward to the next cursor.
    // Page pageCount carries forward if lastPageEndsFeed === false.
    for (let i = 0; i < pageCount; i++) {
      const key = i === 0 ? "FIRST" : `CURSOR_${i}`;
      const isLast = i === pageCount - 1;
      const nextCursor = isLast && lastPageEndsFeed ? null : `CURSOR_${i + 1}`;
      eventPages.set(
        key,
        pageReply(makeEvents(`p${i}`, 1, `2026-05-29T10:${String(i).padStart(2, "0")}:00.000Z`), nextCursor, false),
      );
    }
  }

  it("fires the budget warning when 50 pages all have non-null nextCursor", async () => {
    primeCursorPages(50, /* lastPageEndsFeed */ false);
    const r = await run(["sess-show", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/client page budget \(50 pages of 100\) reached/);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.truncated).toBe(true);
    // The operator-facing nextCursor must be page-50's nextCursor (CURSOR_50),
    // not page-49's, so `mla session show --cursor` (or scripted follow-up)
    // resumes from the right place.
    expect(parsed.nextCursor).toBe("CURSOR_50");
  });

  it("does NOT fire the budget warning when page 50 is the natural last page", async () => {
    // Regression guard for the off-by-one. Before the fix, this case wrongly
    // tripped the warning because the loop-local `cursor` retained
    // CURSOR_49 after the early break on page 50's nextCursor=null.
    primeCursorPages(50, /* lastPageEndsFeed */ true);
    const r = await run(["sess-show", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/client page budget/);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.truncated).toBe(false);
    expect(parsed.nextCursor).toBeNull();
  });
});

describe("mla session show: I5 404 on events endpoint", () => {
  it("maps 404 to a friendly error and exit code 1 (NOT an unhandled throw)", async () => {
    // No entry in eventPages -> server returns 404.
    const r = await run(["sess-ghost"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No agent run found for session sess-ghost/);
    expect(r.stderr).toMatch(/captured by the hooks/);
  });

  it("returns 2 on bad args (parse failure)", async () => {
    const r = await run(["--last"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--last requires a positive integer/);
  });
});
