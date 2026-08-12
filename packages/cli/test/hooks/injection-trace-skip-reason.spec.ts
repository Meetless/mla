// test/hooks/injection-trace-skip-reason.spec.ts
//
// "MLA deliberately skipped this turn" and "MLA never ran here at all" are
// different claims, and until now only one of them was falsifiable from the
// operator's side.
//
// THE MEASUREMENT THAT FORCED THIS. On 2026-08-09, five prod workspaces had
// agent_runs captured and ZERO hook injection traces. Three of them had
// prompt_submitted events, so the hook demonstrably ran; two had none at all.
// Neither shape could be diagnosed from prod, because user-prompt-submit.sh
// spools prompt_submitted UNCONDITIONALLY (line ~141, before intercept_main) and
// then returns early from intercept_main on four paths -- suppressed,
// empty_prompt, harness_event, pull_only -- WITHOUT emitting any trace. The skip
// reason is recorded by write_not_run_trace into ~/.meetless/logs/ask-traces.jsonl
// and never leaves the laptop.
//
// So a session of pure `<task-notification>` wake-ups produces byte-identical
// prod evidence to a broken install: prompts > 0, traces = 0. One is the product
// working correctly. The other is a customer getting nothing. We could not tell
// them apart, which is the same complaint as P2 section 2.2 ("healthy silence and
// completely dead render identically"), one layer down.
//
// The fix reuses substrate that already exists rather than adding any:
//   * deliveryStatus SKIPPED is already in the enum, documented as "enrich never
//     ran (disabled, no-op, rate-limited, prompt too short)" (packages/utils).
//   * The console's Injected lane already renders ONLY INJECTED, so SKIPPED rows
//     cannot pollute the UI.
//   * The contract already accepts it and the writer already stores it.
// No new event type, no new column, no new endpoint.
//
// CONSEQUENCE FOR METRICS, stated here because a silent denominator change is its
// own kind of defect: injection_traces now contains turns where enrichment never
// ran. Any serve-rate must filter to `deliveryStatus <> 'SKIPPED'`. Presence
// metrics (did the hook fire at all this day) should NOT filter, because a
// deliberate skip is still proof MLA was wired and running.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(__dirname, "..", "..", "src", "hooks-template");
const UPS_SH = join(HOOKS, "user-prompt-submit.sh");
const CLI = join(__dirname, "..", "..", "dist", "cli.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

const SID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const WORKSPACE = "ws_skip_reason_spec";
const ACTOR = "wu_skip_reason_spec";

interface Wire {
  port: number;
  close: () => Promise<void>;
}

async function startWire(body: string): Promise<Wire> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let stubSeq = 0;
function makeMlaStub(dir: string, passthrough: string[]): string {
  const p = join(dir, `mla-skip-stub-${++stubSeq}.sh`);
  writeFileSync(
    p,
    [
      "#!/usr/bin/env bash",
      'sub="${2:-}"',
      'case "$sub" in',
      `  ${passthrough.map((x) => `'${x}'`).join("|")}) exec node ${JSON.stringify(CLI)} "$@" ;;`,
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
  return p;
}

function runUps(
  home: string,
  repo: string,
  prompt: string,
  env: Record<string, string> = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [UPS_SH], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? tmpdir(),
        MEETLESS_HOME: home,
        MEETLESS_TURN_RECAP: "off",
        ...env,
      },
      cwd: repo,
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (status) => resolve(status));
    child.stdin.write(JSON.stringify({ session_id: SID, prompt }));
    child.stdin.end();
  });
}

function spooled(home: string): Array<Record<string, any>> {
  const f = join(home, "queue", `${SID}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, any> => !!e);
}

const traces = (home: string) => spooled(home).filter((e) => e.event === "injection_trace");
const prompts = (home: string) => spooled(home).filter((e) => e.event === "prompt_submitted");

describeIfBuilt("a skipped turn must be observable from control, not only on the laptop", () => {
  let intel: Wire;
  let stubDir: string;
  let repo: string;
  let home = "";

  beforeEach(async () => {
    intel = await startWire(
      JSON.stringify({ enrichment: { status: "no_offer", markdown: "" }, steps: [] }),
    );
    stubDir = mkdtempSync(join(tmpdir(), "ml-skip-stub-"));
    repo = mkdtempSync(join(tmpdir(), "ml-skip-repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE }));
    home = mkdtempSync(join(tmpdir(), "ml-skip-home-"));
    mkdirSync(join(home, "queue"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: `http://127.0.0.1:${intel.port}`,
        mlaPath: makeMlaStub(stubDir, ["redact-capture", "assemble-context"]),
        actorUserId: ACTOR,
        auth: { mode: "user-token", accessToken: "t" },
      }),
    );
    writeFileSync(join(home, "queue", `${SID}.workspaceId`), WORKSPACE);
  });

  afterEach(async () => {
    await intel.close();
    for (const d of [stubDir, repo, home]) {
      if (d) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
    home = "";
  });

  it("a harness wake-up spools a SKIPPED trace naming the reason, not silence", async () => {
    // Claude Code feeds `<task-notification>` through UserPromptSubmit exactly
    // like a human prompt. Skipping the WORK is correct. Skipping the RECORD is
    // what made the skip unfalsifiable from prod.
    expect(await runUps(home, repo, "<task-notification>a background task finished</task-notification>")).toBe(0);

    // The asymmetry that produced the ambiguous prod signature.
    expect(prompts(home).length).toBe(1);

    const t = traces(home);
    expect(t).toHaveLength(1);
    expect(t[0].payload.sourceSurface).toBe("HOOK");
    expect(t[0].payload.deliveryStatus).toBe("SKIPPED");
    expect(t[0].payload.status).toBe("harness_event");
    // Nothing was injected, so the structured fields must be honestly empty
    // rather than absent: a reader must not have to guess.
    expect(t[0].payload.contextItems).toEqual([]);
    expect(t[0].payload.actorId).toBe(ACTOR);
  });

  it("the inject-nothing control records itself as SKIPPED/pull_only", async () => {
    expect(
      await runUps(home, repo, "what governs error handling", {
        MEETLESS_INTERCEPT_STRATEGY: "pull_only",
      }),
    ).toBe(0);
    const t = traces(home);
    expect(t).toHaveLength(1);
    expect(t[0].payload.deliveryStatus).toBe("SKIPPED");
    expect(t[0].payload.status).toBe("pull_only");
  });

  it("an ordinary prompt is still INJECTED, and is NOT relabelled as skipped", async () => {
    expect(await runUps(home, repo, "what governs error handling in this repo")).toBe(0);
    const t = traces(home);
    expect(t).toHaveLength(1);
    expect(t[0].payload.deliveryStatus).toBe("INJECTED");
    // Regression guard for the serve-rate denominator: an injecting turn must
    // never carry a skip reason, or every rate that filters on SKIPPED silently
    // drops real deliveries.
    expect(t[0].payload.status).not.toBe("harness_event");
    expect(t[0].payload.status).not.toBe("pull_only");
  });
});
