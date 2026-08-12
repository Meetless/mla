import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync, spawn, ChildProcess } from "child_process";
import { createServer, Server } from "http";
import type { AddressInfo } from "net";
import { parseAskTrace } from "../../src/lib/analytics/turn-recap";

// T1 (notes/20260808-mla-in-this-session-measured-and-a-fix-proposal.md §5.4): the
// abstain-vs-miss discriminator must survive the wire.
//
// The proposal's D2 asserted `trace.*` was null on 11 of 11 turns of session 85d97591 and
// called that the blocker for every other tuning argument. Measured against the live spool
// before writing a line of code, the claim is false: 8 of those 11 turns carry a fully
// populated `governed_kb_trace`, and the 3 that do not are EXACTLY the 3 turns that timed
// out, where curl aborted before a body existed. Null there is the honest value, not a
// lost field (see enrichment-timeout-trace.spec.ts for the same conclusion reached from
// the other direction).
//
// So this suite does what the review asked for regardless of which way the premise fell:
// it converts "the discriminator is present" from an observation into a red-on-regression
// guard, across the four states a reader must be able to tell apart. The distinction that
// actually matters is the LAST one: a healthy zero (we looked, found nothing, and say so
// with integers) must never be confusable with a failure (we could not look, and say so
// with nulls). Those are opposite operator actions, and they are one `// null` apart in
// the hook.
//
// Driven end to end through the REAL hook against a stub intel, because every seam the
// review named (intel response -> serialization -> hook parse -> recap) is between those
// two processes. A unit test over parseAskTrace alone would have passed on all four cases
// in a session where the field never arrived.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_trace_completeness";

type EnrichBody = Record<string, unknown>;

/**
 * A stub intel that answers POST /v1/ask with one canned enrich envelope, in ITS OWN
 * PROCESS.
 *
 * The obvious in-process `createServer` does not work here and fails in the most
 * misleading way available: `spawnSync` blocks this process's event loop for the whole
 * hook run, so an in-process server can accept the connection and never reach its
 * handler. curl then waits out the full budget and the hook writes a TIMEOUT row --
 * `governed_kb_trace: null`, exactly the shape this suite exists to distinguish from a
 * healthy one. The first cut of this file "reproduced" the proposal's D2 defect three
 * times over, and the defect was the harness.
 *
 * (The timeout case below is the one place an in-process server IS correct, because
 * never answering is the behaviour under test.)
 */
function stubIntel(body: EnrichBody): Promise<{ url: string; close: () => void }> {
  const src = `
    const http = require("http");
    const body = ${JSON.stringify(JSON.stringify(body))};
    const s = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
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

type Row = Record<string, unknown> & {
  enrichment: { status: string };
  governed_kb_trace: Record<string, unknown> | null;
  hook: { fail_open_reason: string | null; injected: boolean };
};

async function runHookAgainst(body: EnrichBody): Promise<Row> {
  const server = await stubIntel(body);
  try {
    const home = mkdtempSync(join(tmpdir(), "mla-trace-home-"));
    const repo = mkdtempSync(join(tmpdir(), "mla-trace-repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({
        workspaceId: WORKSPACE_ID,
        actorUserId: "user_a",
        intelUrl: server.url,
        auth: {
          mode: "user-token",
          accessToken: "probe-access-token",
          refreshToken: "probe-refresh-token",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        },
      }),
    );

    spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: "trace_probe",
        prompt: "what did we decide about the coordination case state machine",
        cwd: repo,
      }),
      encoding: "utf8",
      cwd: repo,
      env: {
        ...process.env,
        MEETLESS_HOME: home,
        HOME: home,
        MEETLESS_INTEL_URL: server.url,
      },
      timeout: 30000,
    });

    return readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .pop() as Row;
  } finally {
    server.close();
  }
}

/** intel's real EnrichResponse shape, trimmed to the fields the hook reads. */
function envelope(opts: {
  items?: { source_id: string; text: string }[];
  trace: Record<string, unknown>;
}): EnrichBody {
  const items = opts.items ?? [];
  return {
    enrichment: {
      status: items.length > 0 ? "ok" : "empty",
      confidence: "medium",
      markdown: items.map((i) => `- [${i.source_id}] ${i.text}`).join("\n"),
      context_items: items.map((i, n) => ({
        id: `ctx_${n + 1}`,
        kind: "note",
        source_id: i.source_id,
        text: i.text,
        injected: true,
        status: "PENDING",
        provenance: "governed_kb",
      })),
    },
    steps: [],
    trace: opts.trace,
  };
}

describe("T1: the enrich trace's abstain-vs-miss discriminator survives the wire", () => {
  jest.setTimeout(60000);

  it("healthy candidates: retrieved/selected are integers and the surface is named", async () => {
    const row = await runHookAgainst(
      envelope({
        items: [{ source_id: "NT:notes/20260808-x.md", text: "the acceptance census" }],
        trace: {
          primary_surface: "governed_kb",
          primary_no_offer_reason: null,
          retrieved_count: 12,
          selected_count: 2,
          intent_type: "governed_lookup",
        },
      }),
    );

    expect(row.governed_kb_trace).not.toBeNull();
    const t = parseAskTrace(row)!;
    expect(t.retrieved_count).toBe(12);
    expect(t.selected_count).toBe(2);
    expect(typeof t.retrieved_count).toBe("number");
    expect(typeof t.selected_count).toBe("number");
    expect(t.primary_no_offer_reason).toBeNull();
    expect(row.governed_kb_trace!.primary_surface).toBe("governed_kb");
  });

  it("healthy retrieval that selects nothing: the counts are integers, and selected is a real 0", async () => {
    // The signature the whole discriminator exists for: retrieved > 0 && selected == 0 is
    // "we found candidates and dropped them all", which is recall debt. It is only legible
    // if 0 arrives as 0. A null here would read as "no instrumentation" and the miss would
    // be filed under the same heading as an outage.
    const row = await runHookAgainst(
      envelope({
        items: [],
        trace: {
          primary_surface: "no_offer",
          primary_no_offer_reason: "all_failed_relevance",
          retrieved_count: 9,
          selected_count: 0,
          intent_type: "governed_lookup",
        },
      }),
    );

    const t = parseAskTrace(row)!;
    expect(t.retrieved_count).toBe(9);
    expect(t.selected_count).toBe(0);
    expect(t.selected_count).not.toBeNull();
    expect(t.primary_no_offer_reason).toBe("all_failed_relevance");
  });

  it("router abstention: retrieval never ran, and the reason says so rather than the counts", async () => {
    const row = await runHookAgainst(
      envelope({
        items: [],
        trace: {
          primary_surface: "no_offer",
          primary_no_offer_reason: "router_low_confidence",
          retrieved_count: 0,
          selected_count: 0,
          router_confidence: 0.0,
          intent_type: "unknown",
        },
      }),
    );

    const t = parseAskTrace(row)!;
    // Zero retrieved is structural here (the router abstained BEFORE retrieval), so the
    // zero alone cannot distinguish this from a retrieval that found nothing. The reason
    // is what separates them, and it must ride.
    expect(t.retrieved_count).toBe(0);
    expect(t.selected_count).toBe(0);
    expect(t.primary_no_offer_reason).toBe("router_low_confidence");
  });

  it("failure: a timeout writes nulls, never a healthy zero", async () => {
    // The discriminator's whole point. A timed-out turn must not be representable as
    // "retrieved 0, selected 0", because that is the exact shape of a correct abstention
    // and it would move a plumbing outage into the recall column.
    const server = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s: Server = createServer(() => {
        /* accept and never answer */
      });
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() });
      });
    });
    let row: Row;
    try {
      const home = mkdtempSync(join(tmpdir(), "mla-trace-home-"));
      const repo = mkdtempSync(join(tmpdir(), "mla-trace-repo-"));
      writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
      mkdirSync(join(home, "logs"), { recursive: true });
      writeFileSync(
        join(home, "cli-config.json"),
        JSON.stringify({
          workspaceId: WORKSPACE_ID,
          actorUserId: "user_a",
          intelUrl: server.url,
          auth: {
            mode: "user-token",
            accessToken: "probe-access-token",
            refreshToken: "probe-refresh-token",
            accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
          },
        }),
      );
      spawnSync("bash", [HOOK], {
        input: JSON.stringify({ session_id: "trace_probe_to", prompt: "what did we decide", cwd: repo }),
        encoding: "utf8",
        cwd: repo,
        env: { ...process.env, MEETLESS_HOME: home, HOME: home, MEETLESS_INTEL_URL: server.url, MEETLESS_INTERCEPT_MAX_S: "2" },
        timeout: 30000,
      });
      row = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l))
        .pop() as Row;
    } finally {
      server.close();
    }

    expect(row.enrichment.status).toBe("timeout");
    expect(row.governed_kb_trace).toBeNull();
    const t = parseAskTrace(row)!;
    expect(t.retrieved_count).toBeNull();
    expect(t.selected_count).toBeNull();
    // And the failure is nameable from the same row, so a reader never has to infer it
    // from the absent counts.
    expect(row.hook.fail_open_reason).toBe("timeout");
  });
});
