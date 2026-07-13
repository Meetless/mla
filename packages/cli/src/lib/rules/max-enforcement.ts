/**
 * The session enforcement ceiling: the single lever that decides how far ANY governed
 * rule may go against a tool call, no matter what the rule itself claims.
 *
 * Owner ruling (An, 2026-07-12): "We will only ship warn and never block." So the
 * shipped default is WARN. A rule whose attested ceiling is DENY still evaluates, still
 * records the violation, and still tells the agent it broke a governed rule; it just
 * cannot take the user's tool call (or their file) away from them. Raising the cap to
 * ASK or DENY is an explicit, per-session opt-in via MEETLESS_ACTION_INTERCEPT_MAX.
 *
 * This lives in lib/ rather than next to one hook on purpose. It used to be private to
 * the PreToolUse gate, which meant the PostToolUse sweep never saw it: with the cap set
 * to `warn`, the gate would let a write through as an advisory and then the sweep would
 * silently DELETE the file it had just allowed. One lever, read by every surface that
 * can act on a rule.
 */
import type { EligibleEnforcement } from "./deny-admission";

/** The shipped ceiling. WARN, per the owner ruling. Not a constant to tweak lightly. */
export const DEFAULT_MAX_ENFORCEMENT: EligibleEnforcement = "WARN";

export const MAX_ENFORCEMENT_ENV = "MEETLESS_ACTION_INTERCEPT_MAX";

/**
 * Pure. Parse the ceiling from the env value. `observe` | `warn` | `ask` | `deny` are
 * honored case-insensitively; anything else (unset, empty, garbage) yields the shipped
 * default. An unrecognized value must never be read as "escalate": a typo in a shell
 * profile is not consent to block someone's writes.
 */
export function parseMaxEnforcement(raw: string | undefined): EligibleEnforcement {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "observe":
      return "OBSERVE";
    case "warn":
      return "WARN";
    case "ask":
      return "ASK";
    case "deny":
      return "DENY";
    default:
      return DEFAULT_MAX_ENFORCEMENT;
  }
}

export function resolveMaxEnforcement(env: NodeJS.ProcessEnv = process.env): EligibleEnforcement {
  return parseMaxEnforcement(env[MAX_ENFORCEMENT_ENV]);
}

/**
 * May this runtime revert (delete) a file on the user's behalf? Only at a DENY ceiling.
 * The PostToolUse sweep is the most destructive thing the CLI does, so it asks first.
 */
export function mayRevertFiles(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveMaxEnforcement(env) === "DENY";
}
