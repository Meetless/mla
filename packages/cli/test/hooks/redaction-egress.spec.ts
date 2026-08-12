// test/hooks/redaction-egress.spec.ts
//
// The redaction boundary, asserted where it actually matters: ON THE WIRE.
//
// Code review 2026-07-26 found that only two capture paths went through the ONE
// parity-locked redactor (injected-context blocks and the MCP query text, both via
// `redact-capture`). Everything else the bash hooks spool -- the raw user prompt,
// the assistant's between-tool narration and final message, the whole bash command
// plus its stdout/stderr tails, the agent-decision Q&A -- was written to
// ~/.meetless/queue/<sid>.jsonl verbatim and PATCHed to control verbatim. The
// /v1/ask enrichment `question` was the raw prompt too: middle-truncated, but head
// and tail went out unredacted. A pasted API key in any of those left the machine
// in the clear.
//
// internal-redact-events.spec.ts pins the redaction POLICY (which keys are
// structural, what a payload comes out looking like). This file pins the WIRING,
// because a correct redactor that nothing calls is worth nothing. Both hooks are
// driven as the harness drives them: the REAL scripts under src/hooks-template/,
// a real bash, a real built CLI, and a real HTTP server standing in for control
// and for intel so the assertions are made against the bytes that were actually
// sent -- never against a copy of the script pasted into a TS literal, which
// cannot drift and therefore proves nothing (see home-guard.spec.ts).
//
// The two properties under test, in both directions:
//   1. What reaches the wire is the redactor's OUTPUT. Secrets are gone;
//      correlation ids (eventKey, sessionId, traceId, ...) survive byte-identical,
//      because a batch that lands structurally intact but unjoinable is its own
//      kind of data loss.
//   2. When redaction is UNAVAILABLE, nothing is sent at all. Fail-closed
//      telemetry: a deferred batch is redelivered on the next flush (the server
//      dedupes on eventKey), whereas a secret that left the machine cannot be
//      recalled. The agent still fails OPEN -- the session is never wedged and
//      Layer 1's local floor still injects.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(__dirname, "..", "..", "src", "hooks-template");
const FLUSH_SH = join(HOOKS, "flush.sh");
const UPS_SH = join(HOOKS, "user-prompt-submit.sh");
const CLI = join(__dirname, "..", "..", "dist", "cli.js");

// The redaction gate spawns the BUILT cli (hooks call `$MLA_PATH _internal ...`,
// never ts-node), so these specs need dist/. CI runs `pnpm -r run build` before
// `pnpm run test`, so it is always there in CI; locally a `npm run build` away.
// describe.skip rather than a silent pass: an unbuilt tree must read as SKIPPED.
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

// Distinctive secrets: each is a literal the redactor recognizes (see
// lib/redactor.ts), and each is unique enough that a substring search over the
// entire captured request set is a sound leak detector.
// Each is REAL-SHAPED on purpose. The parity-locked patterns are deliberately
// narrow (`AKIA[0-9A-Z]{16}\b` is exactly the 20-char AWS key id, no more), and
// the generic entropy heuristic only engages at 32 chars, so a token that merely
// looks secret-ish is NOT what these specs should be asserting on. Widening the
// pattern set is a separate, cross-plane decision (intel + control mirror it);
// what is under test here is the wiring, so the fixtures must be things the
// redactor is contracted to catch.
const SECRET_SK = "sk-ant-" + "api03-REDACTIONSPECfakekeyAAAABBBBCCCCDDDDEEEE";
const SECRET_GH = "gh" + "p_REDACTIONSPECfakegithubtokenAAAABBBBCCCC";
const SECRET_AWS = "AKIA" + "REDACTIONSPECFAK";

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface Wire {
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/**
 * A real HTTP server standing in for control / intel. This is the WIRE: every
 * assertion below is made against bytes that a real curl in a real hook actually
 * transmitted, which is the only place a leak is observable.
 */
async function startWire(respond?: (req: CapturedRequest) => string): Promise<Wire> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(respond ? respond(captured) : "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every byte this run put on the wire, concatenated. The leak detector's haystack. */
function allBytes(w: Wire): string {
  return w.requests.map((r) => `${r.method} ${r.url}\n${r.body}`).join("\n");
}

interface HomeOpts {
  controlUrl: string;
  intelUrl?: string;
  mlaPath: string;
}

/**
 * An isolated ~/.meetless. common.sh honors an ABSOLUTE MEETLESS_HOME ahead of
 * $HOME (home-guard.spec.ts pins that), which is what keeps these specs off the
 * operator's real state tree and off the shared cli-config that 10 concurrent
 * sessions read.
 */
function makeHome(opts: HomeOpts): string {
  const home = mkdtempSync(join(tmpdir(), "ml-redact-home-"));
  mkdirSync(join(home, "queue"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: opts.controlUrl,
      intelUrl: opts.intelUrl ?? "http://127.0.0.1:1",
      mlaPath: opts.mlaPath,
      actorUserId: "user_redaction_spec",
      auth: { mode: "user-token", accessToken: "test-access-token" },
    }),
  );
  return home;
}

/**
 * A pinned `mla` for the hooks to call.
 *
 * `passthrough` subcommands exec the REAL built CLI, so the path under test runs
 * production code end to end. Everything else exits 0 immediately: flush.sh's
 * best-effort steer-sync and UPS's turn-recap are unrelated to redaction, and
 * letting them make their own network calls would only add latency and noise.
 * `fail` subcommands exit 1 -- that is how "redaction unavailable" is simulated
 * without breaking the rest of the hook.
 */
let stubSeq = 0;
function makeMlaStub(
  dir: string,
  opts: { passthrough?: string[]; fail?: string[]; garbage?: string[] },
): string {
  const p = join(dir, `mla-stub-${++stubSeq}.sh`);
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join("|");
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      "# generated by test/hooks/redaction-egress.spec.ts",
      'sub="${2:-}"',
      'case "$sub" in',
      opts.fail?.length ? `  ${list(opts.fail)}) exit 1 ;;` : "",
      opts.garbage?.length ? `  ${list(opts.garbage)}) printf 'not json at all'; exit 0 ;;` : "",
      opts.passthrough?.length
        ? `  ${list(opts.passthrough)}) exec node ${JSON.stringify(CLI)} "$@" ;;`
        : "",
      "  *) exit 0 ;;",
      "esac",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  chmodSync(p, 0o755);
  return p;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a hook to completion. ASYNC on purpose: the wire server lives in this same
 * process, and spawnSync would block the event loop for the whole hook, so the
 * server could never accept the hook's connection and every request would come
 * back HTTP 000. `env` REPLACES the environment, so nothing of the operator's
 * leaks in (no proxy vars, no MEETLESS_* left over from jest.setup-home.js).
 */
function runHook(
  script: string,
  argv: string[],
  home: string,
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...argv], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? tmpdir(),
        MEETLESS_HOME: home,
        ...(opts.env ?? {}),
      },
      cwd: opts.cwd ?? tmpdir(),
    });
    let stdout = "";
    let stderr = "";
    // A chunk boundary can fall INSIDE a multi-byte character; setEncoding puts a
    // StringDecoder in front of the seam so `+=` never accumulates a U+FFFD pair.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function runFlush(home: string, sessionId: string): Promise<Run> {
  return runHook(FLUSH_SH, [sessionId], home);
}

function parseMarker(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.startsWith("MLA_FLUSH_RESULT "));
  const out: Record<string, string> = {};
  for (const kv of (line ?? "").replace("MLA_FLUSH_RESULT ", "").trim().split(/\s+/)) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

const SID = "11111111-2222-3333-4444-555555555555";
const WORKSPACE = "ws_redaction_spec";

/** The spool lines: one per previously-leaking capture surface. */
function queueLines(): string {
  const mk = (event: string, key: string, payload: unknown) =>
    JSON.stringify({ ts: "2026-07-26T00:00:00Z", event, eventKey: key, sessionId: SID, payload });
  return (
    [
      mk("prompt_submitted", "key-prompt", {
        prompt: `rotate ${SECRET_SK} for me`,
        promptChars: 42,
        turnId: `${SID}:1`,
        turnIndex: 1,
      }),
      mk("tool_used_bash", "key-bash", {
        command: `curl -H "Authorization: Bearer ${SECRET_GH}" https://api.example.com`,
        stdout: `AWS_ACCESS_KEY_ID=${SECRET_AWS}`,
        stderr: "",
        exitCode: 0,
      }),
      mk("assistant_message", "key-assistant", {
        text: `I will use ${SECRET_SK} to call the API.`,
        kind: "final",
      }),
      mk("agent_decision_captured", "key-decision", {
        prompt: `which key? ${SECRET_GH}`,
        choices: [{ choiceId: "c1", description: `the one ending ${SECRET_AWS}` }],
        answer: { raw: `use ${SECRET_SK}` },
        decisionKind: "ask_user_question",
      }),
    ].join("\n") + "\n"
  );
}

describeIfBuilt("flush.sh: the capture egress boundary", () => {
  let wire: Wire;
  let home: string;
  let stubDir: string;

  beforeEach(async () => {
    wire = await startWire();
    stubDir = mkdtempSync(join(tmpdir(), "ml-redact-stub-"));
  });

  afterEach(async () => {
    await wire.close();
    rmSync(stubDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function seed(mlaPath: string): void {
    home = makeHome({ controlUrl: `http://127.0.0.1:${wire.port}`, mlaPath });
    writeFileSync(join(home, "queue", `${SID}.workspaceId`), WORKSPACE);
    writeFileSync(join(home, "queue", `${SID}.jsonl`), queueLines());
  }

  it("PATCHes the redactor's OUTPUT: no secret reaches control, ids survive intact", async () => {
    seed(makeMlaStub(stubDir, { passthrough: ["redact-events"] }));

    const r = await runFlush(home, SID);
    expect(r.status).toBe(0);
    expect(parseMarker(r.stdout ?? "")).toMatchObject({ delivered: "4", respooled: "0" });

    const patch = wire.requests.find(
      (q) => q.method === "PATCH" && q.url === `/internal/v1/agent-runs/by-session/${SID}/events`,
    );
    expect(patch).toBeDefined();

    // The leak detector: not one of the three secrets appears ANYWHERE in the
    // bytes this flush transmitted, on any request, at any nesting depth.
    const sent = allBytes(wire);
    expect(sent).not.toContain(SECRET_SK);
    expect(sent).not.toContain(SECRET_GH);
    expect(sent).not.toContain(SECRET_AWS);

    const body = JSON.parse(patch!.body) as {
      workspaceId: string;
      events: Array<{ eventKey: string; eventType: string; payload: Record<string, any> }>;
    };
    expect(body.workspaceId).toBe(WORKSPACE);
    const byKey = Object.fromEntries(body.events.map((e) => [e.eventKey, e]));

    // Redacted, and still recognizably the same sentence: the redactor replaces
    // the token, it does not blank the field.
    expect(byKey["key-prompt"].payload.prompt).toBe("rotate [REDACTED] for me");
    expect(byKey["key-bash"].payload.command).toContain("[REDACTED]");
    expect(byKey["key-bash"].payload.stdout).toContain("[REDACTED]");
    expect(byKey["key-assistant"].payload.text).toContain("[REDACTED]");
    // Nested: the agent-decision Q&A leaks through three different shapes.
    expect(byKey["key-decision"].payload.prompt).toContain("[REDACTED]");
    expect(byKey["key-decision"].payload.choices[0].description).toContain("[REDACTED]");
    expect(byKey["key-decision"].payload.answer.raw).toContain("[REDACTED]");

    // Structural fields are the load-bearing half. Blanket redaction would trip
    // the entropy heuristic on every one of these and land a batch control
    // cannot join or dedupe.
    expect(Object.keys(byKey).sort()).toEqual(["key-assistant", "key-bash", "key-decision", "key-prompt"]);
    expect(byKey["key-prompt"].payload.turnId).toBe(`${SID}:1`);
    expect(byKey["key-prompt"].payload.turnIndex).toBe(1);
    expect(byKey["key-prompt"].payload.promptChars).toBe(42);
    expect(byKey["key-bash"].payload.exitCode).toBe(0);
    expect(byKey["key-decision"].payload.choices[0].choiceId).toBe("c1");
    expect(byKey["key-decision"].payload.decisionKind).toBe("ask_user_question");
  });

  // The two ways redaction can be unavailable at runtime. Both must produce the
  // same outcome, and it must NOT be "send it raw".
  const BROKEN: Array<[string, () => string, string]> = [
    [
      "the redactor exits non-zero",
      () => makeMlaStub(stubDir, { fail: ["redact-events"] }),
      "redact-events FAILED",
    ],
    [
      "the redactor writes something that is not a JSON array",
      () => makeMlaStub(stubDir, { garbage: ["redact-events"] }),
      "non-array output",
    ],
  ];

  it.each(BROKEN)("defers the whole batch when %s", async (_label, mkStub, logNeedle) => {
    seed(mkStub());

    const r = await runFlush(home, SID);

    // Fail OPEN for the session: a detached flusher never signals failure upward.
    expect(r.status).toBe(0);
    // Fail CLOSED for the data: nothing delivered, everything kept. (The marker
    // counts EVENTS, not batches, so all four spooled lines come back respooled.)
    expect(parseMarker(r.stdout ?? "")).toMatchObject({ delivered: "0", respooled: "4" });

    // Not "no secret on the wire" -- no EVENTS REQUEST on the wire at all.
    expect(
      wire.requests.filter((q) => q.url.includes("/events")),
    ).toEqual([]);
    const sent = allBytes(wire);
    expect(sent).not.toContain(SECRET_SK);
    expect(sent).not.toContain(SECRET_GH);
    expect(sent).not.toContain(SECRET_AWS);

    // Deferral is not data loss: the lines are back in the queue for the next
    // flush, which the server dedupes on eventKey.
    const respooled = readFileSync(join(home, "queue", `${SID}.jsonl`), "utf8");
    for (const key of ["key-prompt", "key-bash", "key-assistant", "key-decision"]) {
      expect(respooled).toContain(key);
    }

    // And it says so, in the log the operator actually reads.
    const log = readFileSync(join(home, "logs", `flush-${SID}.log`), "utf8");
    expect(log).toContain(logNeedle);
    expect(log).toContain("raw bodies NOT sent");
  });

  it("recovers on the next flush once redaction works again", async () => {
    // The claim the fail-closed path rests on: deferring costs a round trip, not
    // the events. Break it, flush, repair it, flush again.
    seed(makeMlaStub(stubDir, { fail: ["redact-events"] }));
    expect(parseMarker((await runFlush(home, SID)).stdout ?? "")).toMatchObject({ delivered: "0" });
    expect(wire.requests.filter((q) => q.url.includes("/events"))).toEqual([]);

    const cfg = join(home, "cli-config.json");
    const conf = JSON.parse(readFileSync(cfg, "utf8"));
    conf.mlaPath = makeMlaStub(stubDir, { passthrough: ["redact-events"] });
    writeFileSync(cfg, JSON.stringify(conf));

    expect(parseMarker((await runFlush(home, SID)).stdout ?? "")).toMatchObject({ delivered: "4" });
    const patch = wire.requests.find((q) => q.url.includes("/events"));
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.body).events).toHaveLength(4);
    expect(allBytes(wire)).not.toContain(SECRET_SK);
  });
});

describeIfBuilt("user-prompt-submit.sh: the /v1/ask enrichment question", () => {
  let intel: Wire;
  let home: string;
  let repo: string;
  let stubDir: string;

  const PROMPT = `Rotate the prod key ${SECRET_SK} and tell me what governs key rotation`;

  beforeEach(async () => {
    intel = await startWire(() => JSON.stringify({ enrichment: { status: "no_offer", markdown: "" }, steps: [] }));
    stubDir = mkdtempSync(join(tmpdir(), "ml-redact-ups-stub-"));
    repo = mkdtempSync(join(tmpdir(), "ml-redact-repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE }));
  });

  afterEach(async () => {
    await intel.close();
    rmSync(stubDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function runUps(mlaPath: string, prompt: string = PROMPT): Promise<Run> {
    // controlUrl points at a closed port on purpose: the hook's capture spool and
    // its detached flush are not under test here, and a refused connection is the
    // fastest way to keep them out of the way.
    home = makeHome({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: `http://127.0.0.1:${intel.port}`,
      mlaPath,
    });
    return runHook(UPS_SH, [], home, {
      cwd: repo,
      input: JSON.stringify({ session_id: SID, prompt }),
      env: { MEETLESS_TURN_RECAP: "off" },
    });
  }

  function asks(): Array<Record<string, any>> {
    return intel.requests.filter((q) => q.url === "/v1/ask").map((q) => JSON.parse(q.body));
  }

  it("sends the REDACTED prompt as the question, never the raw one", async () => {
    const r = await runUps(
      makeMlaStub(stubDir, { passthrough: ["redact-capture", "assemble-context"] }),
    );
    expect(r.status).toBe(0);

    const bodies = asks();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].question).toBe(
      "Rotate the prod key [REDACTED] and tell me what governs key rotation",
    );
    // Redaction happens BEFORE the oversize middle-truncation, so no head/tail
    // fragment can smuggle a straddling token out.
    expect(allBytes(intel)).not.toContain(SECRET_SK);
  });

  it("asks for the RETRIEVAL profile: the file path survives, the secret does not", async () => {
    // The wiring lock that test/lib/redaction-fidelity.spec.ts cannot provide.
    // That benchmark proves the "retrieval" bar preserves retrieval keys the
    // default "full" bar destroys. The proof is worth nothing if this hook stops
    // ASKING for it, and that regression is SILENT: the question still arrives,
    // still redacted, still HTTP 200. It just no longer contains the thing the
    // retrieval was keyed on, so the enrichment quietly goes empty forever.
    //
    // `meetless-cli/packages/cli/src/lib/redactor` is 41 chars of lower+separator:
    // two character classes, entropy over 3.5, so the "full" bar eats it whole and
    // the question that reaches intel becomes "Explain [REDACTED].ts and rotate
    // [REDACTED]". The "retrieval" bar needs three classes, so it survives. Drop
    // `profile: "retrieval"` from the hook's jq and this assertion fails.
    const prompt = `Explain meetless-cli/packages/cli/src/lib/redactor.ts and rotate ${SECRET_SK}`;
    const r = await runUps(
      makeMlaStub(stubDir, { passthrough: ["redact-capture", "assemble-context"] }),
      prompt,
    );
    expect(r.status).toBe(0);

    const bodies = asks();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].question).toBe(
      "Explain meetless-cli/packages/cli/src/lib/redactor.ts and rotate [REDACTED]",
    );
    // The looser bar is a retrieval concession, not a leak licence: the literal
    // patterns are identical under both profiles, so the credential still goes.
    expect(allBytes(intel)).not.toContain(SECRET_SK);
  });

  it("skips Layer 2 entirely when redaction is unavailable, and still injects Layer 1", async () => {
    // Only the redaction bridge is broken; the rest of the hook is the real CLI,
    // so this is exactly the degradation a missing/crashing redactor produces.
    const r = await runUps(
      makeMlaStub(stubDir, { fail: ["redact-capture"], passthrough: ["assemble-context"] }),
    );

    // Fail open for the agent: the hook exits clean and the local floor still
    // reaches the model. Only the best-effort enrichment was given up.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("additionalContext");

    // Fail closed for the prompt: intel was never called at all.
    expect(intel.requests).toEqual([]);

    const log = readFileSync(join(home, "logs", `flush-${SID}.log`), "utf8");
    expect(log).toContain("prompt redaction unavailable");
    expect(log).toContain("raw prompt NOT sent to intel");
  });

  it("redacts probe_text too: the field carries the prompt's MIDDLE, which nothing else does", async () => {
    // F1 (2026-08-06) added a second prompt-bearing field to this same request. It
    // is the one place where the elided middle now leaves the machine, so it is the
    // one place where a secret buried mid-prompt could newly escape. It cannot,
    // because it is a copy of the ALREADY-redacted string (the 2026-07-26 fix
    // redacts before it truncates) -- but "cannot by construction" is exactly the
    // claim this file exists to stop taking on trust.
    const filler = "the reviewer writes another ordinary sentence here. ".repeat(40);
    const r = await runUps(
      makeMlaStub(stubDir, { passthrough: ["redact-capture", "assemble-context"] }),
      `HEADSTART ${filler} rotate ${SECRET_SK} now ${filler} TAILEND`,
    );
    expect(r.status).toBe(0);

    const bodies = asks();
    expect(bodies).toHaveLength(1);
    // The field is present (the prompt is over the cut) and it carries the middle...
    expect(bodies[0].probe_text).toBeDefined();
    expect(bodies[0].probe_text).toContain("[REDACTED]");
    // ...with the secret redacted out of it, and out of every other byte we sent.
    expect(bodies[0].probe_text).not.toContain(SECRET_SK);
    expect(allBytes(intel)).not.toContain(SECRET_SK);
  });
});
