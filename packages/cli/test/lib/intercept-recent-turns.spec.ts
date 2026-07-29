import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// I4 hook wiring: the UserPromptSubmit hook must pass a RECENT-TURN FEED into the
// intel enrich call (/v1/ask), because intel's `session_local` evidence provider
// reads that feed from the request body and from nowhere else.
//
// THE DEFECT THIS LOCKS DOWN. intel/app/graphs/ask/enrich_session_local.py opens
// with:
//
//     has_feed = bool(recent_turns) or bool((changes_summary or "").strip())
//     if not has_feed: return SessionLocalResult(items=[], provider_available=False)
//
// and `session_local` is the ONLY non-KB surface with a live provider
// (enrich_router_plan.py `_BUILT_NON_KB_SURFACES`). The hook built its enrich body
// with workspace_id / question / surface / mode / strategy / trace_id / stream plus
// an optional touched_files, and never sent recent_turns. So a shipped provider was
// structurally starved: every turn the router sent to `session_report` resolved to
// NO_OFFER with reason `surface_provider_missing`, which reads in the trace exactly
// like "intel has no provider for this". Measured over the local trace log on
// 2026-07-28: 46 of 138 diagnosable turns (33%) died there, and not one of them
// could ever have succeeded.
//
// It is invisible from either end alone. From intel: a well-formed request that
// legitimately has no feed. From the hook: a 200 with an empty enrichment. Only the
// wire shows it, so the assertions below are on the wire.
//
// The provider cannot recover the feed itself: intel never cross-queries control-db
// (the two-DSN discipline), so session content reaches it through the request body
// or not at all.
//
// Only external seam mocked is intel (an in-process HTTP stub), per the project
// testing rules. The stub RECORDS request bodies so we can assert the payload.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";

interface TurnRow {
  turn_id: string;
  sequence: number;
  user_goal: string;
  assistant_summary: string;
  touched_files: string[];
  commands_run: string[];
  outcome: string;
  low_trust: boolean;
}

function requireTools(...tools: string[]): void {
  for (const t of tools) {
    if (spawnSync(t, ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error(`${t} required`);
  }
}

function turnsHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mla-turns-home-"));
  fs.mkdirSync(path.join(h, "queue"), { recursive: true });
  return h;
}

// Source common.sh (which runs under `set -euo pipefail`) and run one snippet
// against a throwaway MEETLESS_HOME, so QUEUE_DIR is isolated per call.
function inCommon(snippet: string, env: Record<string, string> = {}, home?: string): string {
  const h = home ?? turnsHome();
  const r = spawnSync("bash", ["-c", `source "${COMMON}" >/dev/null 2>&1; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: h, MEETLESS_DEBUG: "0", ...env },
  });
  if (!home) fs.rmSync(h, { recursive: true, force: true });
  return (r.stdout || "").trim();
}

function ledgerPath(home: string, sid: string): string {
  return path.join(home, "queue", `${sid}.turns`);
}

// ---------------------------------------------------------------------------
// record_session_turn + collect_recent_turns (common.sh)
// ---------------------------------------------------------------------------
describe("collect_recent_turns (common.sh): the request-carried session feed", () => {
  beforeAll(() => requireTools("jq"));

  it("returns [] for a session that has no ledger yet (compat 6.2: absent field)", () => {
    const home = turnsHome();
    try {
      expect(inCommon(`collect_recent_turns "sess-fresh"`, {}, home)).toBe("[]");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records a turn and reads it back in intel's RecentTurnSummary shape", () => {
    const home = turnsHome();
    try {
      const out = inCommon(
        [`record_session_turn "s" 1 "t-1" "wire the session feed"`, `collect_recent_turns "s"`].join(
          "; ",
        ),
        {},
        home,
      );
      const rows = JSON.parse(out) as TurnRow[];
      expect(rows.length).toBe(1);
      // Every field intel's RecentTurnSummary declares must be present: the model
      // has no defaults for turn_id / sequence / user_goal / assistant_summary /
      // outcome, so a missing one is a 422 on the whole enrich call, not a
      // degraded feed.
      expect(Object.keys(rows[0]).sort()).toEqual([
        "assistant_summary",
        "commands_run",
        "low_trust",
        "outcome",
        "sequence",
        "touched_files",
        "turn_id",
        "user_goal",
      ]);
      expect(rows[0].turn_id).toBe("t-1");
      expect(rows[0].sequence).toBe(1);
      expect(rows[0].user_goal).toBe("wire the session feed");
      // low_trust is Literal[True] on the model: this feed is agent-session
      // derived, never governed evidence, and the flag is what keeps it banded.
      expect(rows[0].low_trust).toBe(true);
      // We do not track apply/revert, so we say so rather than guess. A fabricated
      // outcome would be laundered into the model as evidence.
      expect(rows[0].outcome).toBe("unknown");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("orders FRESHEST FIRST, so a downstream max-items trim keeps the latest turns", () => {
    const home = turnsHome();
    try {
      const out = inCommon(
        [
          `record_session_turn "s" 1 "t-1" "oldest"`,
          `record_session_turn "s" 2 "t-2" "middle"`,
          `record_session_turn "s" 3 "t-3" "newest"`,
          `collect_recent_turns "s"`,
        ].join("; "),
        {},
        home,
      );
      expect((JSON.parse(out) as TurnRow[]).map((r) => r.user_goal)).toEqual([
        "newest",
        "middle",
        "oldest",
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("bounds the feed to MEETLESS_RECENT_TURNS_MAX, truncating the OLDEST turns", () => {
    const home = turnsHome();
    try {
      const snippet = [
        ...["a", "b", "c", "d", "e"].map((g, i) => `record_session_turn "s" ${i} "t-${g}" "${g}"`),
        `collect_recent_turns "s"`,
      ].join("; ");
      const dflt = JSON.parse(inCommon(snippet, {}, home)) as TurnRow[];
      expect(dflt.map((r) => r.user_goal)).toEqual(["e", "d", "c"]); // default cap is 3

      const capped = JSON.parse(
        inCommon(`collect_recent_turns "s"`, { MEETLESS_RECENT_TURNS_MAX: "2" }, home),
      ) as TurnRow[];
      expect(capped.map((r) => r.user_goal)).toEqual(["e", "d"]);

      // A garbage cap must fall back to the default, not to "unbounded" and not to
      // an empty feed.
      const garbage = JSON.parse(
        inCommon(`collect_recent_turns "s"`, { MEETLESS_RECENT_TURNS_MAX: "banana" }, home),
      ) as TurnRow[];
      expect(garbage.length).toBe(3);

      // Zero is an honest off-switch: no feed, and therefore no field on the wire.
      expect(inCommon(`collect_recent_turns "s"`, { MEETLESS_RECENT_TURNS_MAX: "0" }, home)).toBe(
        "[]",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("never reads another session's ledger", () => {
    const home = turnsHome();
    try {
      inCommon(`record_session_turn "sess-other" 1 "t-1" "their private goal"`, {}, home);
      expect(inCommon(`collect_recent_turns "sess-mine"`, {}, home)).toBe("[]");
      const theirs = JSON.parse(inCommon(`collect_recent_turns "sess-other"`, {}, home)) as TurnRow[];
      expect(theirs.map((r) => r.user_goal)).toEqual(["their private goal"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("truncates a long goal so the feed stays a summary, not a second copy of the prompt", () => {
    const home = turnsHome();
    try {
      const long = "x".repeat(5000);
      const rows = JSON.parse(
        inCommon(
          [`record_session_turn "s" 1 "t-1" "${long}"`, `collect_recent_turns "s"`].join("; "),
          {},
          home,
        ),
      ) as TurnRow[];
      expect(rows[0].user_goal.length).toBe(400);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes no ledger for a blank session id, a blank goal, or a non-numeric sequence", () => {
    const home = turnsHome();
    try {
      inCommon(
        [
          `record_session_turn "" 1 "t-x" "no session"`,
          `record_session_turn "s" 1 "t-x" ""`,
          `record_session_turn "s" "banana" "t-ok" "kept anyway"`,
        ].join("; "),
        {},
        home,
      );
      // The two rejects minted nothing; the coerced one survived with sequence 0,
      // because losing the ordinal is cheaper than losing the turn.
      expect(fs.readdirSync(path.join(home, "queue")).sort()).toEqual(["s.turns"]);
      const rows = JSON.parse(inCommon(`collect_recent_turns "s"`, {}, home)) as TurnRow[];
      expect(rows.map((r) => [r.user_goal, r.sequence])).toEqual([["kept anyway", 0]]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("survives a corrupt ledger line rather than dropping the whole feed", () => {
    const home = turnsHome();
    try {
      inCommon(`record_session_turn "s" 1 "t-1" "real turn"`, {}, home);
      fs.appendFileSync(ledgerPath(home, "s"), "not json at all\n");
      // jq -s aborts on a malformed line, and the guard turns that into [] rather
      // than into a broken hook. Either answer is safe; a crash is not.
      const out = inCommon(`collect_recent_turns "s"`, {}, home);
      expect(out.startsWith("[")).toBe(true);
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("trims a runaway ledger instead of growing without bound", () => {
    const home = turnsHome();
    try {
      // 401 appends crosses the keep*2 threshold at least once.
      const snippet = `for i in $(seq 1 401); do record_session_turn "s" "$i" "t-$i" "goal $i"; done`;
      inCommon(snippet, {}, home);
      const lines = fs
        .readFileSync(ledgerPath(home, "s"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(400);
      // The trim must keep the TAIL: the newest turn is the one we send.
      const rows = JSON.parse(inCommon(`collect_recent_turns "s"`, {}, home)) as TurnRow[];
      expect(rows[0].user_goal).toBe("goal 401");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("attributes spool narration and commands to the FRESHEST turn only", () => {
    const home = turnsHome();
    try {
      inCommon(
        [
          `record_session_turn "s" 1 "t-1" "older"`,
          `record_session_turn "s" 2 "t-2" "newer"`,
        ].join("; "),
        {},
        home,
      );
      // The capture spool is not turn-indexed for these two events, so attaching
      // them to every turn would assert a join we cannot prove.
      fs.writeFileSync(
        path.join(home, "queue", "s.jsonl"),
        [
          JSON.stringify({ event: "assistant_message", payload: { narration: "did the thing" } }),
          JSON.stringify({ event: "tool_used_bash", payload: { command: "pnpm build" } }),
          "",
        ].join("\n"),
      );
      const rows = JSON.parse(inCommon(`collect_recent_turns "s"`, {}, home)) as TurnRow[];
      expect(rows[0].assistant_summary).toBe("did the thing");
      expect(rows[0].commands_run).toEqual(["pnpm build"]);
      expect(rows[1].assistant_summary).toBe("");
      expect(rows[1].commands_run).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the wired hook sends recent_turns into intel.
// ---------------------------------------------------------------------------
function startRecordingStub(): Promise<{
  port: number;
  enrich: any[];
  close: () => Promise<void>;
}> {
  const enrich: any[] = [];
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(chunks || "{}");
      } catch {
        parsed = { __unparseable: chunks };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if ((req.url ?? "").includes("/v1/ask")) {
        enrich.push(parsed);
        res.end(
          JSON.stringify({
            enrichment: {
              strategy: "agentic_mission_structured",
              status: "ok",
              confidence: "high",
              markdown: "## Accepted-record claims (cited; verify before relying):\n- seeded",
              fields_present: ["constraints"],
              context_items: [],
            },
            steps: [],
          }),
        );
      } else {
        res.end("{}");
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        enrich,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

// Run the REAL hook N times against ONE home and ONE workdir, which is the only
// way to test this contract: turn N's body is evidence about turn N-1, so a
// single-shot harness can only ever prove the empty case.
async function runWiredTurns(
  prompts: string[],
  env: Record<string, string> = {},
): Promise<any[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wired-turns-"));
  const stub = await startRecordingStub();
  const sid = "sess-rt";
  try {
    fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
    fs.copyFileSync(path.join(HOOKS_DIR, "home.sh"), path.join(tmp, "home.sh"));
    fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
    fs.chmodSync(path.join(tmp, HOOK), 0o755);

    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, "queue"));
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: `http://127.0.0.1:${stub.port}`,
        controlToken: "ik-test",
        workspaceId: "ws_test",
        // The shim MUST be the real `cat` filter: `mla _internal redact-capture`
        // is the redaction gate on the enrich question, and it fails CLOSED. A
        // dead sentinel here skips Layer 2 entirely and this whole file passes
        // vacuously (jest.global-setup.js).
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
      }),
    );

    const workdir = path.join(tmp, "workdir");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

    for (const prompt of prompts) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("bash", [path.join(tmp, HOOK)], {
          cwd: workdir,
          env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...env },
        });
        child.stdout.on("data", () => {});
        child.stderr.on("data", () => {});
        child.on("error", reject);
        child.on("close", () => resolve());
        child.stdin.write(JSON.stringify({ session_id: sid, prompt }));
        child.stdin.end();
      });
    }

    return stub.enrich;
  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("user-prompt-submit.sh forwards recent_turns to intel", () => {
  beforeAll(() => requireTools("jq", "curl"));

  it("OMITS recent_turns on the first turn (compat 6.2: absent == prompt-only)", async () => {
    const bodies = await runWiredTurns(["What did we decide about the router?"]);
    expect(bodies.length).toBe(1);
    expect("recent_turns" in bodies[0]).toBe(false);
  }, 30000);

  it("CARRIES the prior turn on the second turn, so session_local can offer", async () => {
    const bodies = await runWiredTurns([
      "Wire the session feed into the enrich body.",
      "Now summarize what we just did.",
    ]);
    expect(bodies.length).toBe(2);

    // THE REGRESSION. Before this wiring the field was never sent, so intel's
    // session_local provider returned provider_available=False on every turn and
    // the router's session_report route could only ever emit
    // surface_provider_missing.
    expect(Array.isArray(bodies[1].recent_turns)).toBe(true);
    expect(bodies[1].recent_turns.length).toBe(1);
    expect(bodies[1].recent_turns[0].user_goal).toBe("Wire the session feed into the enrich body.");
    expect(bodies[1].recent_turns[0].low_trust).toBe(true);
    expect(bodies[1].recent_turns[0].outcome).toBe("unknown");

    // A turn is never its OWN evidence: the ledger append runs after the body is
    // built. Without this the model would be handed the current prompt twice, once
    // as the question and once as "what happened before".
    expect(bodies[1].recent_turns[0].user_goal).not.toBe("Now summarize what we just did.");
    expect(bodies[1].question).toBe("Now summarize what we just did.");
  }, 30000);

  it("sends at most the cap, freshest first, across a long session", async () => {
    const bodies = await runWiredTurns(["turn one", "turn two", "turn three", "turn four"]);
    expect(bodies.length).toBe(4);
    expect(bodies[1].recent_turns.map((t: TurnRow) => t.user_goal)).toEqual(["turn one"]);
    expect(bodies[2].recent_turns.map((t: TurnRow) => t.user_goal)).toEqual([
      "turn two",
      "turn one",
    ]);
    expect(bodies[3].recent_turns.map((t: TurnRow) => t.user_goal)).toEqual([
      "turn three",
      "turn two",
      "turn one",
    ]);
    // Distinct turn ids, so intel can dedupe and cite per turn.
    const ids = bodies[3].recent_turns.map((t: TurnRow) => t.turn_id);
    expect(new Set(ids).size).toBe(3);
  }, 60000);

  it("honors the MEETLESS_RECENT_TURNS_MAX=0 off-switch on the wire", async () => {
    const bodies = await runWiredTurns(["turn one", "turn two"], {
      MEETLESS_RECENT_TURNS_MAX: "0",
    });
    expect(bodies.length).toBe(2);
    expect("recent_turns" in bodies[1]).toBe(false);
  }, 30000);
});
