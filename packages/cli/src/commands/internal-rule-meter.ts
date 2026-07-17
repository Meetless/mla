// `mla _internal rule-meter` -- emit one mla_rule_injection analytics event (audit 6.G / 7.10).
//
// Fired DETACHED from the user-prompt-submit hook (spawn_rule_meter) on every turn where the
// assembler produced a head. It takes the meter JSON that `_internal assemble-context` just wrote
// to its --meterFile (pure numbers: how many bytes and rules this prompt was charged, split
// ambient vs scoped), records it to the local events.jsonl, and best-effort forwards to control.
//
// Why a separate process at all: the meter is only computable on the UserPromptSubmit HOT PATH,
// inside the assembler, and that path may never make a network call. So the assembler measures,
// this process ships. Everything here rides OFF the hot path: every failure is swallowed and the
// command exits 0 (except a strict argv parse error -> 2), so a telemetry hiccup can never disturb
// the session that spawned it.
//
// Why the meter arrives as one opaque JSON argv value instead of being recomputed here: matching
// scoped rules needs the PROMPT, and putting the user's prompt in argv would publish it to every
// `ps` on the box. The meter is numbers and booleans only, so it is safe in the process table.
//
// The spawn is a fresh process with NO run context, so trace_id arrives via --trace-id (the SAME
// trace as the turn's enrichment, so the cost joins to the turn it priced) and a fresh run_id is
// minted here (INV-RUN-1: one run_id per invocation, never derived from trace_id).

import { CliConfig, readConfig } from "../lib/config";
import { getRunTraceId, mintRunId } from "../lib/observability";
import {
  buildRuleInjectionPayload,
  coerceRuleMeter,
  ruleInjectionEventId,
} from "../lib/analytics/rule-meter";
import {
  RecordContext,
  flushAnalyticsEvents,
  recordAnalyticsEvent,
} from "../lib/analytics/recorder";
import { machineId } from "../lib/analytics/store";

export interface RuleMeterArgs {
  meter: string | null;
  traceId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  turnIndex: number | null;
}

export function parseArgs(argv: string[]): RuleMeterArgs {
  const out: RuleMeterArgs = {
    meter: null,
    traceId: null,
    workspaceId: null,
    sessionId: null,
    turnIndex: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${a} requires a value.`);
      return v;
    };
    switch (a) {
      case "--meter":
        out.meter = value();
        break;
      case "--trace-id":
        out.traceId = value();
        break;
      case "--workspace-id":
        out.workspaceId = value();
        break;
      case "--session-id":
        out.sessionId = value();
        break;
      case "--turn-index": {
        const v = Number(value());
        out.turnIndex = Number.isInteger(v) ? v : null;
        break;
      }
      default:
        throw new Error(`Unknown flag for \`mla _internal rule-meter\`: ${a}`);
    }
  }
  return out;
}

export interface RuleMeterDeps {
  record?: typeof recordAnalyticsEvent;
  flush?: typeof flushAnalyticsEvents;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  mintRunId?: () => string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runInternalRuleMeter(
  argv: string[],
  deps: RuleMeterDeps = {},
): Promise<number> {
  let args: RuleMeterArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  try {
    if (!args.meter) {
      console.log(JSON.stringify({ recorded: false, reason: "no_meter" }));
      return 0;
    }
    // A meter we cannot parse is a bug in the producer, not a reason to guess. Say so and exit
    // clean; the turn's rules were already delivered, this only costs a row.
    let meter;
    try {
      meter = coerceRuleMeter(JSON.parse(args.meter));
    } catch {
      meter = null;
    }
    if (!meter) {
      console.log(JSON.stringify({ recorded: false, reason: "bad_meter" }));
      return 0;
    }

    const sessionId = args.sessionId ?? ((env.CLAUDE_CODE_SESSION_ID || "").trim() || null);
    // trace_id is mandatory for a joinable event; the spawn passes it explicitly. Without one,
    // record nothing: a cost row that cannot join to the turn it priced is a number with no home.
    const traceId = args.traceId ?? getRunTraceId();
    if (!traceId) {
      console.log(JSON.stringify({ recorded: false, reason: "no_trace_id" }));
      return 0;
    }

    const nowMs = deps.nowMs ?? Date.now();
    const payload = buildRuleInjectionPayload(meter, { turnIndex: args.turnIndex });

    const readCfg =
      deps.readCfg ??
      ((): CliConfig | null => {
        try {
          return readConfig();
        } catch {
          return null;
        }
      });
    const cfg = readCfg();
    const mId = (deps.machineId ?? machineId)();
    const runId = (deps.mintRunId ?? mintRunId)();

    const ctx: RecordContext = {
      workspaceId: args.workspaceId,
      sessionId,
      // Same identity rule as the inject spawn: the hook cannot cheaply resolve the actor cuid, so
      // prefer the configured actor and fall back to the hashed machine id (workspace-scoped and
      // anonymous, never end-user PII).
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "hook",
      now: new Date(nowMs).toISOString(),
    };

    const record = deps.record ?? recordAnalyticsEvent;
    record(
      ctx,
      {
        eventType: "mla_rule_injection",
        eventId: ruleInjectionEventId(sessionId, args.turnIndex),
        payload: payload as unknown as Record<string, unknown>,
      },
      env,
    );

    // Best-effort, bounded, telemetry-gated forward (the consent gate lives inside the forwarder).
    // Skipped entirely when the run has no control config. This is the only reason this process
    // exists as a process: the hot path cannot do this.
    if (cfg) {
      const flush = deps.flush ?? flushAnalyticsEvents;
      await flush(cfg, env);
    }

    console.log(
      JSON.stringify({
        recorded: true,
        turn_index: payload.turn_index,
        always_on_tokens: payload.always_on_tokens,
        scoped_tokens: payload.scoped_tokens,
        avoided_tokens: payload.avoided_tokens,
        always_on_share_bp: payload.always_on_share_bp,
        degraded: payload.degraded,
      }),
    );
    return 0;
  } catch {
    // Fail-soft: a cost row failing to record never disturbs the session.
    console.log(JSON.stringify({ recorded: false, reason: "error" }));
    return 0;
  }
}
