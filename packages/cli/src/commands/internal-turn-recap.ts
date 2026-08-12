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

import * as fs from "fs";
import * as path from "path";
import { CliConfig, readConfig, resolveMeetlessHome } from "../lib/config";
import { describeEgressRefusal } from "../lib/egress/policy";
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

export function renderStyle(recap: TurnRecap, style: RecapStyle, inviteLabel = false): string {
  switch (style) {
    case "block":
      return renderBlock(recap);
    case "block-context":
      return renderBlockContext(recap);
    default:
      return renderFooter(recap, { inviteLabel });
  }
}

/**
 * B.6's once-per-session gate.
 *
 * Claims the right to ask for a label in this session, exactly once, by creating a stamp file with
 * the exclusive-create flag. `wx` makes the claim atomic: two hooks racing on the same session
 * cannot both win, so a concurrent turn cannot produce a second invitation.
 *
 * Fail-CLOSED on any filesystem fault, which is the opposite of most seams here. Everywhere else
 * failing open costs a lost measurement; here it would cost repeated nagging, and §3.12 of the value
 * program rejected the count-keyed nag precisely because teaching a user to dismiss us is not
 * reversible. A missed ask is recoverable; an unbounded one is not.
 *
 * Uses no new flag and no new config: the stamp lives beside the state that already exists in
 * ~/.meetless, keyed by session, and the whole directory is disposable.
 */
export function claimLabelInvitation(sessionId: string, home: string): boolean {
  if (!sessionId) return false;
  try {
    const dir = path.join(home, "label-asks");
    fs.mkdirSync(dir, { recursive: true });
    // Session ids are opaque; keep the filename filesystem-safe rather than trusting the shape.
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
    fs.writeFileSync(path.join(dir, `${safe}.asked`), "", { flag: "wx" });
    return true;
  } catch {
    // EEXIST (already asked this session) or any other fault: do not ask.
    return false;
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
  /** B.6 test seams: the once-per-session claim and the state root it writes under. */
  claimInvitation?: (sessionId: string, home: string) => boolean;
  home?: string;
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
      // B.6: ask at most once per session, and only on a turn that actually delivered a governed
      // item. The delivery test is the verdict, not the offered count: NOT_RUN and NO_OFFER are the
      // two arms with nothing to have an opinion about. The claim is only ATTEMPTED on a qualifying
      // turn, so a session full of NO_OFFERs never burns the one ask it gets.
      const delivered = recap.verdict !== "NOT_RUN" && recap.verdict !== "NO_OFFER";
      const inviteLabel =
        delivered && recap.trace_id
          ? (deps.claimInvitation ?? claimLabelInvitation)(session, deps.home ?? resolveMeetlessHome())
          : false;
      log(renderStyle(recap, args.style, inviteLabel));
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
        } catch (err) {
          // Langfuse/intel outage must degrade to "no score this turn", nothing more.
          // A policy refusal is not an outage and never self-heals, so it gets one
          // body-free line (ruling §2). Still exit 0: the hook is unaffected.
          const refusal = describeEgressRefusal(err, "turn recap");
          if (refusal) console.error(refusal);
        }
      }
    }

    return 0;
  } catch {
    // Fail-soft: never throw into the hook that spawned us.
    return 0;
  }
}
