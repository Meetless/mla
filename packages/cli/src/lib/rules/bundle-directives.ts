/**
 * Adapter: principal-bound rule bundle entries -> scanner directives
 * (notes/20260627-rules-store-unification-backend-sot-proposal.md §6.1, §7 step 3 / G3).
 *
 * Post-cutover, the scanner's prompt-injection set (`confirmedRulesXml`) is sourced from the
 * backend bundle instead of the on-disk `.meetless/rules.md`. This pure
 * function is the mirror of `managedRulesToDirectives`: it turns the bundle's LIVE rule
 * versions into the SAME `Directive` shape the renderer already consumes, so nothing
 * downstream (dedupe, authority ranking, XML rendering) changes.
 *
 * INJECTION FILTER (load-bearing, targeted-rule-injection §5.4): only entries whose payload
 * is the exact legal injection tuple become directives. The boundary is the READER, not a
 * writer assertion (§3.5): a migrated, malformed, or adversarial payload cannot leak into
 * injection by carrying a stray `runtimeInject` channel. `injectionTupleOK` accepts exactly
 * two shapes and rejects everything else (drop; the scanner audits the drop):
 *
 *   - `ambient`: deliveryChannels EXACTLY ["runtimeInject"], enforcementCeiling OBSERVE,
 *     evaluator "none", NO stray trigger  -> inject as a floor rule (no trigger threaded).
 *   - `turn` (valid trigger): same channel/ceiling/evaluator gate            -> inject as a
 *     scoped rule, the {@link TurnTrigger} threaded onto the directive for per-turn matching.
 *
 * This preserves the pre-cutover boundary EXACTLY: pre-cutover, only `.meetless/rules.md`
 * MANAGED rules were injected (`deliveryChannels: ["runtimeInject"]`, ambient), while CE0
 * enforcement rules (the notes-location DENY pilot, `deliveryChannels: ["preToolUse"]`,
 * action) were NEVER injected, only enforced at action time. The tuple gate keeps the DENY
 * pilot out on `mode` AND `channel`, keeps team conventions in, and now also admits the new
 * `turn` scoped rules. An entry we cannot prove is a legal injection tuple is dropped (fail
 * closed: do not inject a rule whose shape we cannot read).
 *
 * Every bundle entry is a human-attested LIVE version (the bundle contract only carries
 * attested rules), so directives are minted `human_attested` uniformly: a MUST_FOLLOW
 * bundle rule earns must-follow injection, matching the managed-file behavior verbatim.
 *
 * PURE: no I/O, no clock, no network. The bundle is fetched and cached elsewhere; this
 * module only reshapes already-validated entries.
 */
import type { Directive, Strength } from "../scanner/types";
import { directiveId } from "../scanner/types";
import type { RuleBundleEntry } from "./control-rule-client";
import type { TurnTrigger } from "./types";
import { parseApplicability } from "./applicability";

/** The provenance label stamped on every directive sourced from the backend bundle. */
export const RULE_BUNDLE_DIRECTIVE_SOURCE = "rule-bundle";

/** The one delivery channel a legal injection tuple may carry, and nothing else. */
const RUNTIME_INJECT_CHANNEL = "runtimeInject";

/**
 * Map a payload's descriptive strength onto the binary directive strength the renderer
 * understands. The payload's `ADVISORY` (a third, weakest tier) degrades to SHOULD_FOLLOW:
 * only an explicit MUST earns must-follow authority, the same conservative rule the managed
 * mapping applies.
 */
function payloadStrengthToDirective(strength: unknown): Strength {
  return strength === "MUST_FOLLOW" ? "MUST_FOLLOW" : "SHOULD_FOLLOW";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The single structural gate into injection (targeted-rule-injection §5.4). Returns
 * `{ injectable: true, trigger? }` for the two legal tuples (trigger present iff `turn`),
 * `{ injectable: false }` for everything else. The check is deliberately EXACT, not
 * permissive: an action rule that also lists `runtimeInject`, a turn rule with a DENY
 * ceiling, an ambient payload with a stray trigger, or a rule wired to a real evaluator all
 * FAIL here even though a channel-only filter would have passed the first. See the four
 * symmetric invariant tests in the spec (turn never reaches the Plane-B gate; action never
 * reaches injection; turn+DENY rejected; ambient+trigger rejected).
 */
export function injectionTupleOK(
  payload: Record<string, unknown>,
): { injectable: true; trigger?: TurnTrigger } | { injectable: false } {
  // Delivery channel must be EXACTLY the single runtimeInject channel: a payload that also
  // carries preToolUse (an action rule wearing an inject channel) is not an injection tuple.
  const channels = payload.deliveryChannels;
  if (!Array.isArray(channels) || channels.length !== 1 || channels[0] !== RUNTIME_INJECT_CHANNEL) {
    return { injectable: false };
  }
  // OBSERVE ceiling only: injection never carries the authority to ASK or DENY.
  if (payload.enforcementCeiling !== "OBSERVE") {
    return { injectable: false };
  }
  // Evaluator "none": an injected rule is a soft reminder, never wired to a compliance gate.
  const compliance = payload.compliance;
  if (!isPlainObject(compliance) || compliance.evaluatorContractVersion !== "none") {
    return { injectable: false };
  }
  // Applicability must parse to exactly ambient (no stray trigger) or a valid turn. The
  // grammar is owned by parseApplicability; this boundary post-checks the mode and, for
  // ambient, rejects a stray trigger the tolerant ambient branch would otherwise ignore.
  const rawApplicability = payload.applicability;
  if (!isPlainObject(rawApplicability)) {
    return { injectable: false };
  }
  const parsed = parseApplicability(rawApplicability);
  if (parsed.status !== "OK" || !parsed.applicability) {
    return { injectable: false };
  }
  const applicability = parsed.applicability;
  if (applicability.mode === "ambient") {
    // Ambient carries NOTHING but its mode. parseApplicability reads only `mode` and tolerates
    // extra keys, so the read boundary itself rejects an ambient payload with a trigger: that
    // is a malformed turn rule, not a floor rule (invariant test 4).
    if (Object.keys(rawApplicability).length !== 1) {
      return { injectable: false };
    }
    return { injectable: true };
  }
  if (applicability.mode === "turn") {
    return { injectable: true, trigger: applicability.trigger };
  }
  // action (or any future mode) never injects.
  return { injectable: false };
}

/**
 * Convert bundle entries into scanner directives, keeping only the legal injection tuples.
 * Same contract as {@link managedRulesToDirectives}: id derived from (source, text) so it is
 * stable and dedupe-friendly, kind RULE, human_attested. Non-object payloads, payloads with
 * no/blank text, and payloads that are not a legal injection tuple ({@link injectionTupleOK})
 * are dropped. Turn rules carry their {@link TurnTrigger} onto the directive so the scan
 * partition can route them to `scopedRules` and the assembler can match them per-turn.
 */
export function bundleEntriesToDirectives(
  entries: readonly RuleBundleEntry[],
  source: string = RULE_BUNDLE_DIRECTIVE_SOURCE,
): Directive[] {
  const dirs: Directive[] = [];
  for (const entry of entries) {
    const payload = entry.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const tuple = injectionTupleOK(p);
    if (!tuple.injectable) continue;
    const rawText = p.text;
    if (typeof rawText !== "string") continue;
    const text = rawText.trim();
    if (!text) continue;
    dirs.push({
      id: directiveId(source, text),
      text,
      source,
      kind: "RULE",
      strength: payloadStrengthToDirective(p.strength),
      attestation: "human_attested",
      // Thread the governed identities so the scan cache, shared matcher, overflow audit,
      // and best-effort omission log can name this rule by its durable backend identity
      // rather than the content-hash `id`. File-sourced directives (.claude/rules,
      // per-service CLAUDE.md) have no bundle identity and fall back to `id` downstream.
      ruleNodeId: entry.ruleNodeId,
      ruleVersionId: entry.ruleVersionId,
      // Turn rules carry their trigger; ambient rules omit the key entirely (never a null/undefined
      // value), matching the "OMITTED, never null" discipline the payload mapper already follows.
      ...(tuple.trigger ? { trigger: tuple.trigger } : {}),
    });
  }
  return dirs;
}
