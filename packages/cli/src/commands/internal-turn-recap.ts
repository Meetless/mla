// `mla _internal turn-recap` -- the machine-facing per-turn assist recap reader
// (Layer B of notes/20260609-mla-per-turn-assist-recap-plan.md). Two callers shell
// out to it:
//   - user-prompt-submit.sh (Layer C-lite): `--style block-context` for the prior
//     turn, injected into the next prompt's context. Best-effort; a slow or empty
//     recap must produce nothing, never an error.
//   - stop.sh (Layer D): `--emit-langfuse` detached at turn-end, to attach the
//     mla_ran / mla_assist scores to the turn's Langfuse trace.
//
// It computes the recap (Layer A computeTurnRecap) for one (session, turn) and
// prints one of three render styles or the raw JSON. Like the other `_internal`
// subcommands it skips analytics capture and is fail-soft: a strict argv parse
// error exits 2; any other failure prints nothing and exits 0 so it can never
// disturb the hook that spawned it.

import { CliConfig, readConfig } from "../lib/config";
import { postTurnRecapToIntel } from "../lib/turn-recap-emit";
import {
  TurnRecap,
  computeTurnRecap,
  renderBlock,
  renderBlockContext,
  renderFooter,
} from "../lib/analytics/turn-recap";

export type RecapStyle = "footer" | "block" | "block-context";

export interface TurnRecapArgs {
  session: string | null;
  turn: number | null;
  style: RecapStyle;
  json: boolean;
  emitLangfuse: boolean;
}

const STYLES: RecapStyle[] = ["footer", "block", "block-context"];

export function parseTurnRecapArgs(argv: string[]): TurnRecapArgs {
  const out: TurnRecapArgs = {
    session: null,
    turn: null,
    style: "footer",
    json: false,
    emitLangfuse: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--session":
        out.session = argv[++i] ?? "";
        if (!out.session) throw new Error("--session requires a value");
        break;
      case "--turn": {
        const v = argv[++i];
        if (!v || !/^[0-9]+$/.test(v) || Number(v) < 1) {
          throw new Error(`--turn requires a positive integer: ${v ?? "(missing)"}`);
        }
        out.turn = Number(v);
        break;
      }
      case "--style": {
        const v = argv[++i] as RecapStyle;
        if (!STYLES.includes(v)) throw new Error(`--style must be one of ${STYLES.join("|")}: ${v ?? "(missing)"}`);
        out.style = v;
        break;
      }
      case "--json":
        out.json = true;
        break;
      case "--emit-langfuse":
        out.emitLangfuse = true;
        break;
      default:
        throw new Error(`Unknown flag for \`mla _internal turn-recap\`: ${a}`);
    }
  }
  return out;
}

export function renderStyle(recap: TurnRecap, style: RecapStyle): string {
  switch (style) {
    case "block":
      return renderBlock(recap);
    case "block-context":
      return renderBlockContext(recap);
    default:
      return renderFooter(recap);
  }
}

// A recap with no usable content to inject: the turn left no trace and we cannot
// even name why (a true "nothing happened" gap, distinct from a known muted /
// suppressed / NO_OFFER turn, all of which carry signal worth surfacing).
function isEmptyRecap(r: TurnRecap): boolean {
  return !r.ran && r.not_run_reason === null;
}

export interface TurnRecapCmdDeps {
  // Test seam: compute the recap. Defaults to the real Layer A reader.
  compute?: (sessionId: string, turnIndex: number) => TurnRecap;
  readCfg?: () => CliConfig | null;
  // Layer D: post the recap to intel so it attaches the Langfuse scores. Defaults
  // to postTurnRecapToIntel; tests inject a recording stub.
  postTurnRecap?: (cfg: CliConfig, recap: TurnRecap) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export async function runInternalTurnRecap(argv: string[], deps: TurnRecapCmdDeps = {}): Promise<number> {
  let args: TurnRecapArgs;
  try {
    args = parseTurnRecapArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    const session = args.session ?? env.CLAUDE_CODE_SESSION_ID ?? "";
    if (!session || args.turn === null) {
      // Nothing to compute against. Silent, fail-soft (the hook ignores this).
      return 0;
    }

    const compute = deps.compute ?? ((s: string, t: number) => computeTurnRecap(s, t));
    const recap = compute(session, args.turn);

    if (args.json) {
      log(JSON.stringify(recap));
    } else if (args.style === "block-context" && isEmptyRecap(recap)) {
      // C-lite: inject nothing when there is genuinely nothing to say.
    } else {
      log(renderStyle(recap, args.style));
    }

    // Layer D emission: detached, best-effort, never blocks the agent.
    // No-op when no trace id (nothing to attach a score to).
    if (args.emitLangfuse && recap.trace_id) {
      const readCfg =
        deps.readCfg ??
        ((): CliConfig | null => {
          try {
            return readConfig();
          } catch {
            return null;
          }
        });
      const postTurnRecap = deps.postTurnRecap ?? postTurnRecapToIntel;
      const cfg = readCfg();
      if (cfg) {
        try {
          await postTurnRecap(cfg, recap);
        } catch {
          // Langfuse/intel outage must degrade to "no score this turn", nothing more.
        }
      }
    }

    return 0;
  } catch {
    // Fail-soft: never throw into the hook that spawned us.
    return 0;
  }
}
