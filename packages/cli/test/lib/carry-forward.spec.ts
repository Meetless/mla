import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// A5 relevance-persistence ("carry ONCE") behavioral lock.
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 A5 / §7.4 A5;
// the read-path verdict is notes/20260604-p2-prior-trace-read-verification.md.
//
// P2 verified the prior trace line is only WRITTEN, never read into enrich at
// turn N+1, and that intel cannot read the local trace (two-DSN; the trace lives
// on the operator's machine). So A5 reads it HOOK-SIDE, mirroring P1/P3:
// user-prompt-submit.sh reads its own immediately-prior trace line for this
// session, and AFTER the enrich for N+1 returns, intersects the prior INJECTED
// source_ids (carry_count == 0, prior turn not rated harmful) with this turn's
// surfaced source_ids. Any survivor is "still the closest match" -> carried ONCE
// with a soft, informational tag, and stamped carry_count = 1 so the next turn's
// once-only decay drops it. The three acceptance cases (§7.4 A5):
//   (1) high-value item still top-match next turn, carry_count==0 -> carried once;
//   (2) same item, carry_count>=1 -> NOT carried (once-only decay holds);
//   (3) item rated harmful last turn -> NOT carried regardless of relevance.
//
// Two external seams only: the in-process HTTP stub standing in for intel
// /v1/ask (per the testing rules) and the local ask-traces.jsonl we pre-seed.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";

const CARRY_TAG = 'kind="carry-forward"';

// An enrich body whose context_items carry real source_ids + injected:true,
// matching the live trace shape (the default intercept-hook stub uses a bare
// {id} without source_id, which A5 deliberately ignores).
function enrichWith(sourceIds: string[], opts: { md?: string; confidence?: string } = {}) {
  const md =
    opts.md ??
    "## Retrieved LIVE memory candidates (not relevance-filtered); verify before using:\n" + sourceIds.map((s) => `- relevant thing [${s}]`).join("\n");
  return {
    enrichment: {
      strategy: "retrieval_only",
      status: "ok",
      confidence: opts.confidence ?? "medium",
      markdown: md,
      latency_ms: 100,
      cost_usd: 0,
      usefulness_self_score: null,
      fields_present: [],
      context_items: sourceIds.map((s, i) => ({
        id: `ctx_${i}`,
        kind: "architecture_constraint",
        source_id: s,
        provenance: "derived_from_accepted_kb",
        status: "accepted",
        text: "...",
        injected: true,
      })),
      total_tokens_in: 0,
      total_tokens_out: 0,
    },
    steps: [],
  };
}

// One trace line in the shape write_trace emits, reduced to the fields A5 reads.
function injectTrace(opts: {
  sessionId: string;
  turn: number;
  injectedSourceIds?: string[];
  carried?: { source_id: string; carry_count: number }[];
  harmful?: boolean;
}) {
  const items = (opts.injectedSourceIds ?? []).map((s, i) => ({
    id: `ctx_${i}`,
    kind: "architecture_constraint",
    source_id: s,
    provenance: "derived_from_accepted_kb",
    status: "accepted",
    text: "...",
    injected: true,
  }));
  return {
    trace_id: `t${opts.turn}`,
    ts: "2026-06-04T00:00:00Z",
    surface: "cli_intercept",
    mode: "enrich",
    session_id: opts.sessionId,
    turn_index: opts.turn,
    enrichment: { strategy: "retrieval_only", status: "ok", context_items: items },
    arbitration: { decision: "injected", reason: "enrichment_driven", discarded_after_compute: false },
    hook: { injected: true, layer2_injected: (opts.injectedSourceIds ?? []).length > 0 },
    carry_forward: opts.carried ? { carried: opts.carried } : null,
    operator_label: {
      useful: null,
      noisy: null,
      harmful: opts.harmful === true ? true : null,
      prevented_mistake: null,
      notes: null,
    },
  };
}

interface Stub {
  url: string;
  setEnrich: (body: unknown) => void;
  enrichHits: () => number;
  close: () => Promise<void>;
}

function startStub(): Promise<Stub> {
  let enrich = 0;
  let body: unknown = enrichWith([]);
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      if ((req.url ?? "").includes("/v1/ask")) {
        enrich++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        setEnrich: (b) => (body = b),
        enrichHits: () => enrich,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

function makeHome(intelUrl: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-carry-"));
  fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);
  // A real no-op mla stub. `/bin/true` is NOT present on every host (absent on
  // this macOS), so pointing mlaPath there fails the hook's `[[ -x ]]` guard and
  // MLA_PATH silently falls through to the globally-installed real mla, whose
  // `assemble-context` pays Node startup on every turn and touches the real
  // ~/.meetless. Under parallel Jest workers that latency tips the multi-turn
  // integration tests past the 5s default timeout. A stdin-draining bash stub
  // (empty stdout -> the intended bash-native Layer1/Layer2/carry fallback path)
  // is instant, side-effect-free, and portable across macOS + Linux CI.
  const mlaStub = path.join(tmp, "mla-noop");
  fs.writeFileSync(mlaStub, "#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nexit 0\n");
  fs.chmodSync(mlaStub, 0o755);
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.mkdirSync(path.join(home, "queue"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl,
      controlToken: "ik-test",
      workspaceId: "ws_test",
      mlaPath: mlaStub,
    }),
  );
  fs.writeFileSync(path.join(tmp, "workdir-marker"), tmp); // stash root for cleanup
  (makeHome as any)._root = tmp;
  return home;
}

function seedTrace(home: string, lines: object[]) {
  fs.writeFileSync(
    path.join(home, "logs", "ask-traces.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
  );
}

function seedTurn(home: string, sessionId: string, n: number) {
  fs.writeFileSync(path.join(home, "queue", `${sessionId}.turn`), String(n));
}

interface RunResult {
  status: number;
  additionalContext: string | null;
  trace: any | null;
  traceLines: number;
  stdout: string;
}

async function runHook(args: {
  tmpRoot: string;
  home: string;
  sessionId: string;
  prompt?: string;
  env?: Record<string, string>;
  intelDown?: boolean;
}): Promise<RunResult> {
  const workdir = path.join(args.tmpRoot, "workdir");
  if (!fs.existsSync(workdir)) {
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");
  }
  if (args.intelDown) {
    // Repoint enrich at a closed port so curl fails fast (connection refused):
    // Layer 2 falls to layer1_only and the carry path never runs.
    const cfgPath = path.join(args.home, "cli-config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.intelUrl = "http://127.0.0.1:1";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  }
  const input = JSON.stringify({
    session_id: args.sessionId,
    prompt: args.prompt ?? "How does the auth gateway enforce scope?",
  });
  let out = "";
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn("bash", [path.join(args.tmpRoot, HOOK)], {
      cwd: workdir,
      env: { ...process.env, MEETLESS_HOME: args.home, MEETLESS_DEBUG: "0", ...(args.env ?? {}) },
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
    child.stdin.write(input);
    child.stdin.end();
  });
  const traceFile = path.join(args.home, "logs", "ask-traces.jsonl");
  const raw = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const trace = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  let additionalContext: string | null = null;
  const trimmed = out.trim();
  if (trimmed.startsWith("{")) {
    try {
      additionalContext = JSON.parse(trimmed)?.hookSpecificOutput?.additionalContext ?? null;
    } catch {
      additionalContext = null;
    }
  }
  return { status, additionalContext, trace, traceLines: lines.length, stdout: out };
}

// Run read_prior_carry_state / compute_carry directly out of common.sh.
function bashFn(home: string, fn: string, ...fnArgs: string[]): { stdout: string; status: number } {
  const r = spawnSync(
    "bash",
    ["-c", `source "$1"; ${fn} "\${@:2}"`, "_", path.join(home, "..", "common.sh"), ...fnArgs],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: home } },
  );
  return { stdout: (r.stdout ?? "").trim(), status: r.status ?? -1 };
}

describe("A5 carry-forward (relevance-persistence, carry ONCE)", () => {
  let stub: Stub;
  const roots: string[] = [];

  beforeAll(async () => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required for carry-forward specs");
    if (spawnSync("curl", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("curl required for carry-forward specs");
    stub = await startStub();
  });
  afterAll(async () => {
    await stub.close();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function freshHome(): { home: string; root: string } {
    const home = makeHome(stub.url);
    const root = (makeHome as any)._root as string;
    roots.push(root);
    return { home, root };
  }

  // ---- common.sh helpers: read_prior_carry_state -----------------------------
  describe("read_prior_carry_state", () => {
    it("missing file -> empty carry, not harmful", () => {
      const { home } = freshHome();
      const out = bashFn(home, "read_prior_carry_state", "sess-x").stdout;
      expect(JSON.parse(out)).toEqual({ prior_carry: {}, harmful: false });
    });

    it("prior injected items map to carry_count 0; non-injected are excluded", () => {
      const { home } = freshHome();
      seedTrace(home, [
        injectTrace({ sessionId: "sess-x", turn: 1, injectedSourceIds: ["NT:foo", "DD:1"] }),
      ]);
      const state = JSON.parse(bashFn(home, "read_prior_carry_state", "sess-x").stdout);
      expect(state.prior_carry).toEqual({ "NT:foo": 0, "DD:1": 0 });
      expect(state.harmful).toBe(false);
    });

    it("carried items map to their stamped carry_count; carried wins over injected on collision", () => {
      const { home } = freshHome();
      seedTrace(home, [
        injectTrace({
          sessionId: "sess-x",
          turn: 2,
          injectedSourceIds: ["NT:foo"],
          carried: [{ source_id: "NT:foo", carry_count: 1 }],
        }),
      ]);
      const state = JSON.parse(bashFn(home, "read_prior_carry_state", "sess-x").stdout);
      expect(state.prior_carry["NT:foo"]).toBe(1); // carried (cc 1) overrides injected (cc 0)
    });

    it("operator_label.harmful=true surfaces as harmful:true", () => {
      const { home } = freshHome();
      seedTrace(home, [
        injectTrace({ sessionId: "sess-x", turn: 1, injectedSourceIds: ["NT:foo"], harmful: true }),
      ]);
      expect(JSON.parse(bashFn(home, "read_prior_carry_state", "sess-x").stdout).harmful).toBe(true);
    });

    it("reads the LATEST turn for the session and ignores other sessions", () => {
      const { home } = freshHome();
      seedTrace(home, [
        injectTrace({ sessionId: "sess-x", turn: 1, injectedSourceIds: ["NT:old"] }),
        injectTrace({ sessionId: "other", turn: 9, injectedSourceIds: ["NT:wrong"] }),
        injectTrace({ sessionId: "sess-x", turn: 2, injectedSourceIds: ["NT:new"] }),
      ]);
      const state = JSON.parse(bashFn(home, "read_prior_carry_state", "sess-x").stdout);
      expect(state.prior_carry).toEqual({ "NT:new": 0 });
    });

    it("tolerates a malformed trailing line", () => {
      const { home } = freshHome();
      fs.writeFileSync(
        path.join(home, "logs", "ask-traces.jsonl"),
        JSON.stringify(injectTrace({ sessionId: "sess-x", turn: 1, injectedSourceIds: ["NT:foo"] })) +
          "\n{not valid json\n",
      );
      const state = JSON.parse(bashFn(home, "read_prior_carry_state", "sess-x").stdout);
      expect(state.prior_carry).toEqual({ "NT:foo": 0 });
    });
  });

  // ---- common.sh helpers: compute_carry (pure) -------------------------------
  describe("compute_carry", () => {
    const enr = (sids: string[]) => JSON.stringify(enrichWith(sids).enrichment);

    it("case 1: prior-injected item still surfaced, cc 0 -> carried once with cc 1", () => {
      const { home } = freshHome();
      const state = JSON.stringify({ prior_carry: { "NT:foo": 0 }, harmful: false });
      const carried = JSON.parse(bashFn(home, "compute_carry", state, enr(["NT:foo", "DD:9"])).stdout);
      expect(carried).toEqual([{ source_id: "NT:foo", carry_count: 1 }]);
    });

    it("case 2: prior carry_count>=1 -> NOT carried (once-only decay)", () => {
      const { home } = freshHome();
      const state = JSON.stringify({ prior_carry: { "NT:foo": 1 }, harmful: false });
      const carried = JSON.parse(bashFn(home, "compute_carry", state, enr(["NT:foo"])).stdout);
      expect(carried).toEqual([]);
    });

    it("case 3: prior turn harmful -> nothing carried regardless of relevance", () => {
      const { home } = freshHome();
      const state = JSON.stringify({ prior_carry: { "NT:foo": 0 }, harmful: true });
      const carried = JSON.parse(bashFn(home, "compute_carry", state, enr(["NT:foo"])).stdout);
      expect(carried).toEqual([]);
    });

    it("topic shifted (no overlap) -> nothing carried", () => {
      const { home } = freshHome();
      const state = JSON.stringify({ prior_carry: { "NT:foo": 0 }, harmful: false });
      const carried = JSON.parse(bashFn(home, "compute_carry", state, enr(["DD:9", "DD:10"])).stdout);
      expect(carried).toEqual([]);
    });

    it("empty prior carry -> nothing carried", () => {
      const { home } = freshHome();
      const carried = JSON.parse(
        bashFn(home, "compute_carry", JSON.stringify({ prior_carry: {}, harmful: false }), enr(["NT:foo"]))
          .stdout,
      );
      expect(carried).toEqual([]);
    });
  });

  // ---- hook integration ------------------------------------------------------
  it("case 1 (integration): carries a still-relevant prior-injected item once with the soft tag", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [injectTrace({ sessionId: "sess-c1", turn: 1, injectedSourceIds: ["NT:foo"] })]);
    seedTurn(home, "sess-c1", 1);
    stub.setEnrich(enrichWith(["NT:foo", "DD:9"]));

    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-c1" });
    expect(r.status).toBe(0);
    expect(r.additionalContext).toContain(CARRY_TAG);
    expect(r.additionalContext).toContain("NT:foo");
    expect(r.additionalContext).toContain("still"); // soft "still the closest match" wording
    expect(r.trace.carry_forward.carried).toEqual([{ source_id: "NT:foo", carry_count: 1 }]);
    expect(r.traceLines).toBe(2); // prior + this turn
  });

  it("case 2 (integration): once-only decay -- an already-carried item is not carried again", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [
      injectTrace({
        sessionId: "sess-c2",
        turn: 2,
        injectedSourceIds: ["NT:foo"],
        carried: [{ source_id: "NT:foo", carry_count: 1 }],
      }),
    ]);
    seedTurn(home, "sess-c2", 2);
    stub.setEnrich(enrichWith(["NT:foo"]));

    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-c2" });
    expect(r.status).toBe(0);
    expect(r.additionalContext).not.toContain(CARRY_TAG);
    expect(r.trace.carry_forward?.carried ?? []).toEqual([]);
  });

  it("case 3 (integration): a prior turn rated harmful suppresses the carry", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [
      injectTrace({ sessionId: "sess-c3", turn: 1, injectedSourceIds: ["NT:foo"], harmful: true }),
    ]);
    seedTurn(home, "sess-c3", 1);
    stub.setEnrich(enrichWith(["NT:foo"]));

    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-c3" });
    expect(r.additionalContext).not.toContain(CARRY_TAG);
    expect(r.trace.carry_forward?.carried ?? []).toEqual([]);
  });

  it("no prior trace (first turn): no carry block, carry_forward dormant, still injects Layer 1+2", async () => {
    const { home, root } = freshHome();
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-first" });
    expect(r.additionalContext).toContain('kind="static"');
    expect(r.additionalContext).toContain('kind="evidence"');
    expect(r.additionalContext).not.toContain(CARRY_TAG);
    expect(r.trace.carry_forward?.carried ?? []).toEqual([]);
  });

  it("layer1_only (intel down): never crashes, no carry block, no carried", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [injectTrace({ sessionId: "sess-down", turn: 1, injectedSourceIds: ["NT:foo"] })]);
    seedTurn(home, "sess-down", 1);
    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-down", intelDown: true });
    expect(r.status).toBe(0);
    expect(r.additionalContext).toContain('kind="static"');
    expect(r.additionalContext).not.toContain(CARRY_TAG);
    expect(r.trace.carry_forward?.carried ?? []).toEqual([]);
  });

  it("MEETLESS_CARRY_FORWARD=0 disables the carry even when an item is eligible", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [injectTrace({ sessionId: "sess-off", turn: 1, injectedSourceIds: ["NT:foo"] })]);
    seedTurn(home, "sess-off", 1);
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-off", env: { MEETLESS_CARRY_FORWARD: "0" } });
    expect(r.additionalContext).not.toContain(CARRY_TAG);
    expect(r.trace.carry_forward?.carried ?? []).toEqual([]);
  });

  it("full sequence: fresh inject -> carried next turn -> once-only decay the turn after", async () => {
    const { home, root } = freshHome();
    const sid = "sess-seq";
    // Turn 1: fresh inject of NT:foo (no prior -> no carry).
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r1 = await runHook({ tmpRoot: root, home, sessionId: sid });
    expect(r1.additionalContext).not.toContain(CARRY_TAG);
    expect(r1.trace.carry_forward?.carried ?? []).toEqual([]);

    // Turn 2: NT:foo still surfaced AND not yet carried (cc 0) -> carried once.
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r2 = await runHook({ tmpRoot: root, home, sessionId: sid });
    expect(r2.additionalContext).toContain(CARRY_TAG);
    expect(r2.trace.carry_forward.carried).toEqual([{ source_id: "NT:foo", carry_count: 1 }]);

    // Turn 3: NT:foo still surfaced but now carry_count==1 -> once-only decay, NOT carried.
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r3 = await runHook({ tmpRoot: root, home, sessionId: sid });
    expect(r3.additionalContext).not.toContain(CARRY_TAG);
    expect(r3.trace.carry_forward?.carried ?? []).toEqual([]);
    expect(r3.traceLines).toBe(3);
  });

  it("carry block lands AFTER the Layer 2 evidence block and the trace line stays valid JSON", async () => {
    const { home, root } = freshHome();
    seedTrace(home, [injectTrace({ sessionId: "sess-order", turn: 1, injectedSourceIds: ["NT:foo"] })]);
    seedTurn(home, "sess-order", 1);
    stub.setEnrich(enrichWith(["NT:foo"]));
    const r = await runHook({ tmpRoot: root, home, sessionId: "sess-order" });
    const iEvidence = r.additionalContext!.indexOf('kind="evidence"');
    const iCarry = r.additionalContext!.indexOf(CARRY_TAG);
    expect(iEvidence).toBeGreaterThanOrEqual(0);
    expect(iCarry).toBeGreaterThan(iEvidence);
    expect(typeof r.trace).toBe("object");
    expect(r.trace.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  // Drift guard: the helpers stay wired into the hook.
  it("drift guard: user-prompt-submit.sh calls both A5 helpers", () => {
    const hook = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(hook).toContain("read_prior_carry_state");
    expect(hook).toContain("compute_carry");
    const common = fs.readFileSync(COMMON, "utf8");
    expect(common).toContain("read_prior_carry_state()");
    expect(common).toContain("compute_carry()");
  });
});
