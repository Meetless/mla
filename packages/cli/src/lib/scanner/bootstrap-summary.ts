import { Directive, ScanInventory, ScanResult } from "./types";
import { buildStructuredRules } from "./scan";

// GAP1 Slice 1: the activation "what we found" surface.
//
// `mla activate` already runs the deterministic Tier-1 scan, extracts directives,
// builds provisional context, and injects the high-confidence rules into the hot
// path (the M-slices + scanner + injector cover steps 2-5 of the design's
// `mla activate --bootstrap fast`, notes/20260611-onboarding-mla.md:1917). What was
// missing is step 6: the "Active agent instructions" review bundle that lets the
// human SEE what was found and what Meetless will do with it. That is the first-
// session magic moment; until now the card showed only raw file counts.
//
// Everything here is pure rendering over the existing ScanResult. It introduces NO
// new store: it reads the same three lists the scan already produces, split on the
// two-axis model:
//   - directives         : human-authored / high-confidence, injected NOW.
//   - advisoryDirectives : machine_inferred, awaiting review, NEVER auto-injected.
//   - staleSignals       : need a keep/drop verdict.

const MAX_DIRECTIVES_SHOWN = 5;

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The inventory headline. Kept identical to the long-standing card so its callers
// and golden assertions are unchanged; renderBootstrapSummary leads with it.
export function renderActivationCard(inv: ScanInventory): string {
  return [
    `Found: ${pluralize(inv.instructionFiles, "agent-instruction file")} · ` +
      `${pluralize(inv.decisionDocs, "decision/spec doc")} · ` +
      `${pluralize(inv.legacyNotes, "legacy note")} · ` +
      `${pluralize(inv.staleSignals, "likely-stale signal")}.`,
    // Not "Meetless will use these". It does not: the delivery path carries no plain CLAUDE.md
    // rule (see the directive branch below), and the agent already loads the file itself. What
    // Meetless does with them is INDEX them, so retrieval can answer from this repo rather than
    // returning empty for every query. Kept in step with the line the directive branch prints;
    // two headlines making opposite claims about the same files is how the old one survived.
    "Meetless indexes what your repo already states so retrieval can answer from it. Nothing is accepted until you review it.",
  ].join("\n");
}

// MUST_FOLLOW before SHOULD_FOLLOW; otherwise stable (the scan's own order). A
// stable sort keeps equal-strength directives in discovery order.
function byStrength(a: Directive, b: Directive): number {
  const rank = (d: Directive) => (d.strength === "MUST_FOLLOW" ? 0 : 1);
  return rank(a) - rank(b);
}

function directiveBullet(d: Directive): string {
  return `  • ${d.text}  (${d.source})`;
}

/**
 * Render the full "Active agent instructions" bundle for `mla activate`. Leads with
 * the inventory headline, then (only when non-empty):
 *   - the high-confidence directives the repo already states, MUST_FOLLOW first (capped, with
 *     an "and N more" tail), reported as FOUND rather than as injected;
 *   - the scoped rules that genuinely ride Meetless's per-turn delivery, when any qualify;
 *   - the count of machine_inferred advisory candidates awaiting review, with the
 *     `mla context advisory` pointer and an explicit "not injected" note;
 *   - the count of likely-stale signals needing a verdict, with `mla context list`.
 * An empty graph degrades to a calm "nothing high-confidence yet" line; it never
 * prints an empty section header or a stray bullet.
 *
 * There used to be an `injectedNow` option here, added on 2026-07-12 to stop the card claiming
 * "Guiding this session now (injected)" when `mla activate` ran from a plain terminal with no
 * session to inject into. That guard is now unreachable rather than merely unused: the card no
 * longer makes ANY session-scoped injection claim about file-sourced directives, because
 * measurement showed none of them are injected in either case (see the header comment in the
 * directive branch). A boolean that can no longer change a single byte of output is not a
 * safety net, it is a field the next reader will assume is load-bearing, so it is gone. Whether
 * capture started THIS session is still reported, by `mla activate` itself, which is the layer
 * that actually knows.
 */
export function renderBootstrapSummary(scan: ScanResult): string {
  const lines: string[] = [renderActivationCard(scan.inventory)];

  const directives = [...scan.directives].sort(byStrength);
  if (directives.length > 0) {
    lines.push("");
    // What this header may NOT say, and why. It used to promise that these rules were "guiding
    // this session now (injected)" or "will guide the next Claude Code session". Measured on a
    // fresh repo 2026-08-06: 9 directives extracted, 0 floor rules, 1 scoped rule. Eight of the
    // nine reached no delivery array at all, because `buildStructuredRules` puts a directive on
    // the floor only when it is bundle-sourced and in scoped only when it carries globs or a
    // turn trigger, and a plain CLAUDE.md line is neither. They land in `confirmedRulesXml`,
    // which is the retired first-run pack and has had no reader since Phase 2.
    //
    // The exclusion is right; the promise was not. The agent already reads CLAUDE.md and
    // .claude/rules on its own, so re-injecting them is the duplication 7f0f4f1cb measured at
    // 94.7% of everything MLA delivered. So the card now states what is true: we READ these, we
    // do not re-inject them, and here is the lane that governs them instead.
    lines.push("Already instructing your agent in this repo (read from your own files):");
    const shown = directives.slice(0, MAX_DIRECTIVES_SHOWN);
    for (const d of shown) {
      lines.push(directiveBullet(d));
    }
    const remaining = directives.length - shown.length;
    if (remaining > 0) {
      lines.push(`  …and ${pluralize(remaining, "more rule")}.`);
    }
    lines.push(
      "  Your coding agent already loads these files itself, so Meetless does not re-inject them.",
    );

    // The one file-sourced shape that DOES ride Meetless's delivery path: a `.claude/rules`
    // entry carrying explicit `paths:` globs becomes a scoped rule, matched per turn. Derived
    // from `buildStructuredRules`, the same partition the assembler uses, so this line can never
    // drift from what is actually delivered. Silent when nothing qualifies: an empty "0 scoped
    // rules" line is noise, and a promise made about zero rules is the bug this replaced.
    const { scopedRules } = buildStructuredRules(scan.directives);
    if (scopedRules.length > 0) {
      lines.push(
        `  ${pluralize(scopedRules.length, "scoped rule")} carry path globs, so Meetless delivers ` +
          `${scopedRules.length === 1 ? "it" : "them"} on the turns that touch those paths.`,
      );
    }
  } else {
    lines.push("");
    lines.push("No high-confidence agent instructions found yet; this first run stays provisional.");
  }

  if (scan.advisoryDirectives.length > 0) {
    lines.push("");
    lines.push(
      `Awaiting your review: ${pluralize(scan.advisoryDirectives.length, "advisory rule")} ` +
        "from agent memory (machine_inferred, NOT injected).",
    );
    lines.push("  See them with `mla context advisory`.");
  }

  if (scan.staleSignals.length > 0) {
    lines.push("");
    lines.push(
      `Possibly stale: ${pluralize(scan.staleSignals.length, "signal")} that may no longer apply.`,
    );
    lines.push("  Review and keep/drop with `mla context list`.");
  }

  return lines.join("\n");
}
