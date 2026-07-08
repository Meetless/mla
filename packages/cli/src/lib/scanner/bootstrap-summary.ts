import { Directive, ScanInventory, ScanResult } from "./types";

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
    "For your first run, Meetless will use high-confidence project instructions and mark everything else provisional.",
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
 *   - the high-confidence directives guiding the session now (capped, with an "and N
 *     more" tail), MUST_FOLLOW first;
 *   - the count of machine_inferred advisory candidates awaiting review, with the
 *     `mla context advisory` pointer and an explicit "not injected" note;
 *   - the count of likely-stale signals needing a verdict, with `mla context list`.
 * An empty graph degrades to a calm "nothing high-confidence yet" line; it never
 * prints an empty section header or a stray bullet.
 */
export function renderBootstrapSummary(scan: ScanResult): string {
  const lines: string[] = [renderActivationCard(scan.inventory)];

  const directives = [...scan.directives].sort(byStrength);
  if (directives.length > 0) {
    lines.push("");
    lines.push("Guiding this session now (high-confidence, injected):");
    const shown = directives.slice(0, MAX_DIRECTIVES_SHOWN);
    for (const d of shown) {
      lines.push(directiveBullet(d));
    }
    const remaining = directives.length - shown.length;
    if (remaining > 0) {
      lines.push(`  …and ${pluralize(remaining, "more rule")}.`);
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
