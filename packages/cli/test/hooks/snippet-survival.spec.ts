// G4: the third instrument. Every number we own counts IDENTIFIERS, and identifiers all
// survived.
//
// THE DEFECT (notes/20260811-did-mla-help-session-5e8a7182-the-composer-writes-12kb-into-a-1-2kb-pipe.md
// I2, §3.2). `mla_serve_path_v1.yaml` draws the boundary in its own header: it grades
// what intel SELECTED, and "IT IS NOT WHAT REACHED THE MODEL. The hook's per-item
// budgeter runs after the wire and can drop items; the field that describes THAT is
// `hook.delivered_citations`". Two layers, two instruments -- and both of them are
// ID-grained. On session 5e8a7182 turn 1 all four citations survived and every number
// was green, while the bytes carrying the answer did not survive at all.
//
// There is a third layer. It is INSIDE the item, and nothing graded it.
//
// THE PROPERTY, and it is deliberately the whole of it:
//
//     given a selected item, a known matched span, and a transport budget,
//     the final model-visible evidence contains that span.
//
// WHAT THIS SUITE DOES NOT DO. No gate. No target percentage. No new entity, lifecycle
// or subsystem. And it cannot see whether the agent then USED the span, which is a
// different question that citation counts already fail to answer; quoting a green run
// here as "the agent read it" would be the same over-claim in a new place.
//
// WHERE THE FIX LIVES. Intel now projects span-first when the caller declares a budget
// (G1+G2), so the composed item ALREADY leads with the matched region and the hook's
// head-first cut preserves it. That makes this suite a transport-fidelity regression:
// it pins that the budgeter does not destroy a span-first projection, and that a
// head-first projection of the same document loses it. The projection itself is graded
// on intel's side (app/graphs/ask/evidence_span_projection_test.py); this is the half
// that runs where the budgeter lives, exactly as the serve-path file's own rule says.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");
const MARKER = "[...truncated by Meetless...]";

function budget(md: string, max: number): string {
  return execFileSync(
    "bash",
    ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; budget_evidence_markdown "$(cat)" "$1"', "mla-g4", String(max)],
    {
      input: md,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, COMMON_SH, MEETLESS_HOME: mkdtempSync(join(tmpdir(), "mla-g4-")), MEETLESS_DEBUG: "0" },
    },
  ).toString();
}

// Session 5e8a7182 turn 1's document, in the shape it was delivered: front matter, a
// closed-workstream opening, and the decisive claim well past any plausible budget.
const SOURCE_ID = "NT:notes/20260805-f2-claim-authority-mapping-trace.md";
const TITLE = "F2 4.1: Branch A, and the projection is already built, wired and tested";
const DECISIVE = "a PENDING draft is admitted only as explicitly-unsettled, never as a settled current fact.";
const FRONT_MATTER =
  `# ${TITLE}\n\n` +
  "Date: 2026-08-05\n" +
  "Status: TRACE COMPLETE. Branch A. No implementation needed. Step 2 of F2 is DONE.\n" +
  "Supersedes the open question in `20260805-f2-retraction-authority-trace.md` 6.\n\n" +
  "The mapping table below walks each authority column against the storage column it is\n".repeat(30);

/** What intel composed BEFORE this change: the document from byte 0. */
function headFirstItem(): string {
  return `- [pending][${SOURCE_ID}] ${TITLE}: ${FRONT_MATTER}\n${DECISIVE}\n`;
}

/** What intel composes AFTER it is told the budget: the matched span, led by the title. */
function spanFirstItem(): string {
  return `- [pending][${SOURCE_ID}] ${TITLE}\n[...]\n${DECISIVE}\n`;
}

const BAND_HEADER = "Pending / unconfirmed (retrieved, not accepted):\n";

// The budget that turn actually delivered into that item.
const TURN1_BUDGET = 500;

describe("G4: snippet fidelity -- does the matched span reach the model", () => {
  it("the fixture is not vacuous: the decisive span sits past the budget head-first", () => {
    const composed = BAND_HEADER + headFirstItem();
    expect(composed.indexOf(DECISIVE)).toBeGreaterThan(TURN1_BUDGET);
  });

  it("REGRESSION: a head-first composition loses the decisive span at this budget", () => {
    // Today's failure, pinned so the fix has something to have fixed. This is the exact
    // geometry of turn 1: the right document, delivered, carrying none of its answer.
    const delivered = budget(BAND_HEADER + headFirstItem(), TURN1_BUDGET);
    expect(delivered).toContain(SOURCE_ID); // the citation survived...
    expect(delivered).not.toContain(DECISIVE); // ...and the answer did not.
    expect(delivered).toContain(MARKER);
  });

  it("a span-first composition delivers the decisive span at the SAME budget", () => {
    // Not more bytes. The same bytes, spent on different ones.
    const delivered = budget(BAND_HEADER + spanFirstItem(), TURN1_BUDGET);
    expect(delivered).toContain(DECISIVE);
    expect(delivered).toContain(SOURCE_ID);
  });

  it("keeps the citation and the band header attached to the span", () => {
    // A span with no citation is unusable evidence, and a span rendered under the wrong
    // band header is worse than a lost one: it mislabels pending material as accepted.
    const delivered = budget(BAND_HEADER + spanFirstItem(), TURN1_BUDGET);
    expect(delivered.startsWith(BAND_HEADER)).toBe(true);
    expect(delivered).toContain(`- [pending][${SOURCE_ID}]`);
  });

  it("survives the floored budget across three items, which is 48.4% of evidence turns", () => {
    const md = BAND_HEADER + [spanFirstItem(), spanFirstItem(), spanFirstItem()].join("");
    const delivered = budget(md, 1200);
    // Every item carries its span, or the floored case -- the one this most has to
    // serve -- is still delivering titles.
    const hits = delivered.split(DECISIVE).length - 1;
    expect(hits).toBe(3);
  });

  it("never exceeds the budget it was given", () => {
    for (const max of [300, 500, 1200, 2400]) {
      const delivered = budget(BAND_HEADER + [spanFirstItem(), headFirstItem()].join(""), max);
      expect(Buffer.byteLength(delivered, "utf8")).toBeLessThanOrEqual(max);
    }
  });
});
