// Drive the REAL UserPromptSubmit hook against a stub intel, and read back the trace
// line and the additionalContext the model would have received.
//
// Extracted so the delivered-citation and head-pressure suites share ONE harness rather
// than a third and fourth copy of it. test/lib/enrich-trace-completeness.spec.ts keeps
// its own copy on purpose: it predates this and its cases assert on timeout behaviour
// that needs an in-process server.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync, spawn, ChildProcess } from "child_process";

export const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");

export type EnrichBody = Record<string, unknown>;

/**
 * A stub intel answering POST /v1/ask with one canned envelope, IN ITS OWN PROCESS.
 *
 * The obvious in-process `createServer` does not work: `spawnSync` below blocks this
 * process's event loop for the whole hook run, so an in-process server accepts the
 * connection and never reaches its handler. curl then waits out the budget and the hook
 * writes a TIMEOUT row, which looks exactly like the defect these suites test for.
 */
export function stubIntel(body: EnrichBody, requestLog?: string): Promise<{ url: string; close: () => void }> {
  const src = `
    const http = require("http");
    const fs = require("fs");
    const body = ${JSON.stringify(JSON.stringify(body))};
    const log = ${JSON.stringify(requestLog ?? "")};
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // WHAT THE HOOK ACTUALLY SENT. Recorded, not inferred: a request field that is
        // computed correctly and then dropped from the jq body renders identically to
        // one that was never computed, and that is the whole failure class G1 adds a
        // field to. Best-effort so a write failure can never hang the stub.
        //
        // RE-SERIALIZED COMPACT on purpose. \`jq -n\` pretty-prints, so the body arrives
        // across many lines and a naive JSONL append produces a file whose every line is
        // a fragment. That read as "the hook sent nothing", which is indistinguishable
        // from the defect this recorder exists to catch.
        if (log) {
          try {
            const raw = Buffer.concat(chunks).toString();
            let line = raw;
            try { line = JSON.stringify(JSON.parse(raw)); } catch {}
            fs.appendFileSync(log, line.replace(/\\n/g, " ") + "\\n");
          } catch {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
    s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
  `;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stub intel did not report a port"));
    }, 10000);
    child.stdout!.on("data", (b: Buffer) => {
      const m = /PORT=(\d+)/.exec(b.toString());
      if (!m) return;
      clearTimeout(timer);
      resolve({ url: `http://127.0.0.1:${m[1]}`, close: () => child.kill() });
    });
  });
}

export interface HookRun {
  trace: Record<string, any>;
  additionalContext: string;
  /** The enrich request bodies the hook actually put on the wire, in order. */
  requests: Record<string, any>[];
}

/** Temp dirs every run creates; call {@link cleanupHookRuns} from afterAll. */
const scratch: string[] = [];

export function cleanupHookRuns(): void {
  // maxRetries: a detached flush may still be writing under a home dir when the suite
  // ends, and a bare recursive rmSync races it (enforced repo-wide by
  // test/lib/teardown-rmsync-is-retried.spec.ts).
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  scratch.length = 0;
}

/**
 * A fake `mla` whose `_internal assemble-context` prints a head of EXACTLY `headBytes`
 * bytes. Every other subcommand is the default passthrough (`redact-capture` must
 * `cat`, or the enrich redaction gate reads empty output and fails closed).
 *
 * The head is what the hook subtracts from the inline ceiling, so this is the knob that
 * puts the evidence budget under pressure without touching the ceiling itself.
 */
export function makeHeadStub(headBytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mla-head-stub-"));
  scratch.push(dir);
  const p = join(dir, "mla");
  // A real-shaped head: one meetless-context block padded to the requested size.
  const open = '<meetless-context kind="floor-rules" trust="must-follow">\n';
  const close = "\n</meetless-context>";
  const pad = "x".repeat(Math.max(0, headBytes - open.length - close.length));
  writeFileSync(
    p,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1 $2" == "_internal assemble-context" ]]; then\n` +
      `  cat >/dev/null 2>&1 || true\n` +
      `  printf '%s' ${JSON.stringify(open + pad + close)}\n` +
      `  exit 0\n` +
      `fi\n` +
      `case "$2" in redact-events|redact-capture) exec cat ;; esac\n` +
      `exit 0\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

export async function runEnrichHook(
  body: EnrichBody,
  opts: {
    mlaPath?: string;
    prompt?: string;
    sessionId?: string;
    /**
     * Seed files under the hook's MEETLESS_HOME before it runs. The home is created here,
     * so a suite that needs one of the hook's local caches (the governance pending-count,
     * a steer cache) has no other way to reach it.
     */
    homeSetup?: (home: string) => void;
    /**
     * Seed BOTH temp dirs before the hook runs. Sibling of `homeSetup` for the cases
     * that need the two together: a per-session ledger under the home naming absolute
     * paths inside the repo cannot be written by either callback alone.
     */
    setup?: (dirs: { home: string; repo: string }) => void;
    /** Extra environment for the hook process, e.g. MEETLESS_INLINE_CONTEXT_CEILING. */
    env?: Record<string, string>;
  } = {},
): Promise<HookRun> {
  const wire = mkdtempSync(join(tmpdir(), "mla-hookrun-wire-"));
  scratch.push(wire);
  const requestLog = join(wire, "requests.jsonl");
  const server = await stubIntel(body, requestLog);
  try {
    const home = mkdtempSync(join(tmpdir(), "mla-hookrun-home-"));
    const repo = mkdtempSync(join(tmpdir(), "mla-hookrun-repo-"));
    scratch.push(home, repo);
    const workspaceId = "ws_hook_run";
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({
        workspaceId,
        actorUserId: "user_a",
        intelUrl: server.url,
        ...(opts.mlaPath ? { mlaPath: opts.mlaPath } : {}),
        auth: {
          mode: "user-token",
          accessToken: "probe-access-token",
          refreshToken: "probe-refresh-token",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        },
      }),
    );

    opts.homeSetup?.(home);
    opts.setup?.({ home, repo });

    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: opts.sessionId ?? "hook_run_probe",
        prompt: opts.prompt ?? "did MLA help this session and what did it actually deliver",
        cwd: repo,
      }),
      encoding: "utf8",
      cwd: repo,
      env: {
        ...process.env,
        MEETLESS_HOME: home,
        HOME: home,
        MEETLESS_INTEL_URL: server.url,
        ...(opts.env ?? {}),
      },
      timeout: 30000,
    });

    const trace = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .pop() as Record<string, any>;
    let additionalContext = "";
    try {
      additionalContext = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? "";
    } catch {
      additionalContext = "";
    }
    let requests: Record<string, any>[] = [];
    try {
      requests = readFileSync(requestLog, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    } catch {
      requests = [];
    }
    return { trace, additionalContext, requests };
  } finally {
    server.close();
  }
}

/** intel's EnrichResponse, rendered through the SAME band shape agentic_service emits. */
export function envelope(items: { source_id: string; text: string }[]): EnrichBody {
  return {
    enrichment: {
      status: items.length > 0 ? "ok" : "empty",
      confidence: "medium",
      markdown: items.length
        ? "Pending / unconfirmed (retrieved, not accepted):\n" +
          items.map((i) => `- [pending][${i.source_id}] ${i.text}`).join("\n")
        : "",
      context_items: items.map((i, n) => ({
        id: `ctx_${n + 1}`,
        kind: "note",
        source_id: i.source_id,
        citation: i.source_id,
        text: i.text,
        injected: true,
        status: "pending",
        provenance: "governed_kb",
      })),
    },
    steps: [],
    trace: {
      primary_surface: "governed_kb",
      primary_no_offer_reason: null,
      retrieved_count: items.length,
      selected_count: items.length,
      intent_type: "governed_lookup",
    },
  };
}
