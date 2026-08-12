// F3: when the evidence budget forces a cut, cut at a boundary the reader can use.
//
// THE DEFECT (notes/20260807-did-mla-help-this-session-measured-and-a-fix-proposal.md
// §2.1, §3 D6). The per-item budgeter cuts to a byte allowance and appends
// `[...truncated by Meetless...]`. `utf8_cut_bytes` guarantees the cut does not split a
// CHARACTER; nothing guaranteed it did not split a SENTENCE, and it routinely did:
//
//     Reviewed and approved with two corre[...truncated by Meetless...]
//
// That is not a cheaper version of the evidence, it is a fragment whose last clause the
// reader cannot use and, worse, might complete wrongly. Measured on session 6ab21c5e
// turn 2 and again on the turn-6 chunking-profile question, where the load-bearing
// sentence sat a few lines past the cut.
//
// THE FIX IS NOT A RANKER. Inspection of intel's projector settled that: `text` on a
// context item is `title + ": " + snippet` and `snippet` IS the matched retrieval
// passage (`RetrievalCandidate.snippet`, the matched chunk for a chunk-lane hit). There
// is no separate "matched region" hiding inside it to go find with a second heading
// scorer, so the whole job is to stop the cut landing mid-thought: back up from the byte
// allowance to the nearest paragraph / section / sentence / line boundary, and take the
// raw byte cut only when no boundary is close enough to be worth the loss.
//
// SCOPED 2026-08-12, because the paragraph above is now half true and the half that
// stopped being true argues against a shipped fix. It reasoned from ONE retrieval arm.
// A chunk-lane hit does return the matched chunk, but the whole-document arm packs up to
// 8,000 characters of a note's body into `snippet`, and a 2KB chunk against a floored
// ~300-byte share is no more "the matched region" than a document is. On session
// 5e8a7182 turn 1 the decisive claim sat at byte 3,729 of the composed item and the
// transport delivered 500.
//
// So there IS a matched region, it is found from the query rather than from a heading
// scorer, and it is selected where the budget and the query both exist: in intel
// (`app/graphs/ask/evidence_span_projection.py`, G1+G2), which is also where the PULL
// surface has done it since 2026-08-05. THIS FILE IS UNCHANGED BY THAT. The boundary
// ladder below is still the last cut, still head-first, and still correct: it now runs
// over a payload that already leads with the span, so a boundary-safe cut of a
// span-first item keeps the span. `snippet-survival.spec.ts` pins that pairing.
//
// These drive the REAL bash functions in common.sh, not a copy.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");
const MARKER = "[...truncated by Meetless...]";

function bash(script: string, args: string[], input: string, home: string): string {
  return execFileSync("bash", ["-c", script, "mla-f3", ...args], {
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", COMMON_SH },
  }).toString();
}

/** Run `budget_evidence_markdown "$md" "$max"` against the real common.sh. */
function budget(md: string, max: number, home: string): string {
  return bash(
    'source "$COMMON_SH" >/dev/null 2>&1; budget_evidence_markdown "$(cat)" "$1"',
    [String(max)],
    md,
    home,
  );
}

/** Run `cut_at_boundary "$text" "$max"` against the real common.sh. */
function cutAtBoundary(text: string, max: number, home: string): string {
  return bash(
    'source "$COMMON_SH" >/dev/null 2>&1; cut_at_boundary "$(cat)" "$1"',
    [String(max)],
    text,
    home,
  );
}

/** The delivered text of each item, marker stripped, for readability assertions. */
function segments(out: string): string[] {
  return out
    .split(/^- \[/m)
    .slice(1)
    .map((s) => `- [${s}`);
}

describe("F3: the evidence cut lands on a boundary, not mid-sentence", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-f3-"));
  });
  afterEach(() => {
    // maxRetries: a hook may still be writing under this dir when the test ends, and a
    // bare recursive rmSync races it. Enforced repo-wide by
    // test/lib/teardown-rmsync-is-retried.spec.ts, which caught this file.
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  // The reproducer from the proposal, verbatim in shape: a long item whose allowance
  // expires in the middle of the word "corrections".
  it("does not cut mid-word (the 'two corre[...truncated...]' reproducer)", () => {
    const item =
      "- [pending][NT:notes/20260806-sibling-audit.md] Sibling audit. " +
      "The reconciler walks each sibling in turn and records a verdict. " +
      "Reviewed and approved with two corrections that both landed before the cutover.";
    const out = budget(item, 150, home);

    expect(out).toContain(MARKER);
    const delivered = out.slice(0, out.indexOf(MARKER));
    expect(delivered).not.toMatch(/\bcorre$/);
    // The allowance here comfortably clears the first sentence, so the cut takes it.
    expect(delivered.trimEnd()).toMatch(/[.!?:;)\]"']$|\n$/);
  });

  // THE WEAKER CONTRACT: at every allowance the hook can actually produce, never split
  // a word.
  //
  // Sentence integrity cannot be universal and claiming it would be dishonest: an
  // allowance smaller than the citation prefix plus the first sentence contains no
  // sentence boundary to cut at, and there the only choices are a whole word or a
  // fragment.
  //
  // 240 is `min_share`, the smallest per-item allowance the budgeter will ever
  // construct (below it the whole block takes the global path, whose own floor is
  // MAX_MD >= 1200). The sweep starts there ON PURPOSE rather than at 0, because
  // measured below ~90 bytes the cut lands INSIDE the 30-character citation token
  // `[NT:notes/20260514-plan-v2.md]`, which has no internal space to back up to, and
  // the word rung's floor correctly refuses to throw away two thirds of the allowance
  // reaching for one. That regime is unreachable from the hook and is pinned by its own
  // case below rather than papered over here.
  it("never splits a word, at every allowance the hook can produce", () => {
    const item =
      "- [pending][NT:notes/20260514-plan-v2.md] " +
      "Implement the chunking profiles module per section 6.7. " +
      "Single profile constant MARKDOWN_ATOMIC_V1. No engine code yet, and no second " +
      "profile has ever existed in the registry or in its history.";
    for (let max = 240; max <= item.length + 40; max += 3) {
      const out = budget(item, max, home);
      const delivered = out.includes(MARKER) ? out.slice(0, out.indexOf(MARKER)) : out;
      const rest = item.slice(delivered.length);
      // Either we consumed the whole item, or the source character immediately after
      // the cut is whitespace: that is exactly "the cut fell between two words".
      expect(rest === "" || /^\s/.test(rest)).toBe(true);
    }
  });

  // The pathological regime, pinned so it stays a KNOWN limit rather than a surprise.
  // An allowance too small to hold one unbreakable token takes the raw character-safe
  // cut, exactly as documented. It is unreachable from the hook (see above); if a
  // future budget change makes it reachable, this is the case that has to be revisited.
  it("below one unbreakable token, the raw character-safe cut stands", () => {
    const item =
      "- [pending][NT:notes/20260514-plan-v2.md] a body long enough to overflow the tiny allowance";
    const out = budget(item, 60, home);
    expect(out).toContain(MARKER);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(60);
    // Still valid UTF-8, still inside the budget: only the word guarantee is waived.
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
  });

  // THE §2.1 SHAPE, at allowances that can actually hold a sentence: the answer is a
  // complete sentence, and the cut either delivers it whole or stops before it.
  it("delivers whole sentences once the allowance can hold one", () => {
    const sentences = [
      "Implement the chunking profiles module per section 6.7.",
      "Single profile constant MARKDOWN_ATOMIC_V1.",
      "No engine code yet, and no second profile has ever existed.",
      "The registry is closed and the reconciler depends on that.",
    ];
    const item = `- [pending][NT:notes/20260514-plan-v2.md] ${sentences.join(" ")}`;
    // The citation prefix (42) + the first sentence + the marker's own cost (31, paid
    // out of the allowance) is the floor below which the payload contains no sentence
    // boundary at all. One byte of slack, because an allowance that lands exactly one
    // byte short of the full stop legitimately has none either.
    const smallest = 42 + sentences[0].length + 31 + 1;

    for (let max = smallest; max <= item.length + 40; max += 7) {
      const out = budget(item, max, home);
      const delivered = (out.includes(MARKER) ? out.slice(0, out.indexOf(MARKER)) : out).trimEnd();
      for (const s of sentences) {
        // A sentence is either fully present or fully absent; never a prefix of it.
        if (delivered.indexOf(s.slice(0, 12)) === -1) continue;
        expect(delivered).toContain(s);
      }
    }
  });

  // A markdown section boundary is a better cut than a sentence boundary inside the
  // previous section, because a heading with no body under it is worse than no heading.
  it("prefers a section boundary and never leaves a dangling heading", () => {
    const item =
      "- [accepted][NT:notes/a.md] Overview line one. Overview line two.\n" +
      "\n" +
      "## Registry\n" +
      "\n" +
      "The registry holds exactly one profile and always has.";
    // An allowance that reaches the heading but not its body.
    const out = budget(item, 95, home);
    const delivered = out.slice(0, out.indexOf(MARKER));
    if (delivered.includes("## Registry")) {
      expect(delivered).toMatch(/## Registry[\s\S]*\S/);
      expect(delivered.trimEnd()).not.toMatch(/## Registry$/);
    }
  });

  // The budget is a HARD ceiling. Backing up to a boundary may only ever deliver LESS.
  it("never exceeds the byte budget while looking for a boundary", () => {
    const item =
      "- [pending][NT:notes/b.md] " +
      Array.from({ length: 40 }, (_, i) => `Sentence number ${i} runs on for a while.`).join(" ");
    for (let max = 60; max <= 900; max += 13) {
      const out = budget(item, max, home);
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(max);
    }
  });

  // Multibyte safety is not regressed: backing up to a boundary must not reintroduce
  // the split-character defect utf8_cut_bytes exists to prevent.
  it("keeps every cut valid UTF-8 on Vietnamese and CJK evidence", () => {
    const item =
      "- [accepted][NT:notes/vi.md] Bằng chứng đã truy xuất. " +
      "Quyết định đã được phê duyệt. 決定事項はひとつだけです。 Điều khoản triển khai đã xong.";
    for (let max = 60; max <= 260; max += 3) {
      const out = budget(item, max, home);
      expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    }
  });

  // Degenerate inputs must degrade to the raw byte cut rather than to nothing. A
  // boundary search that can return an empty string would silently delete evidence.
  it("falls back to the raw cut when no boundary is close enough", () => {
    // One 400-char run with no sentence, line or section boundary anywhere in it.
    const blob = "x".repeat(400);
    const out = cutAtBoundary(blob, 100, home);
    expect(Buffer.byteLength(out, "utf8")).toBe(100);
    expect(out).toBe("x".repeat(100));
  });

  it("returns the text unchanged when it already fits", () => {
    const text = "Short. Fits.";
    expect(cutAtBoundary(text, 1000, home)).toBe(text);
  });

  it("gives back at most the budget and at least most of it", () => {
    // The boundary search is bounded: it may not sacrifice an unbounded amount of the
    // allowance chasing a nicer cut. A cut that keeps 12 of 200 allowed bytes because
    // that is where the last period fell is a worse outcome than a mid-sentence cut.
    const text =
      "A. " + "y".repeat(300);
    const out = cutAtBoundary(text, 200, home);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(out, "utf8")).toBeGreaterThanOrEqual(140);
  });

  // The invariant the per-item budgeter already had, re-asserted through the new cut:
  // a band header may never be eaten, because pending evidence rendered under the
  // accepted header is the one failure worse than losing an item.
  it("still never eats a band header", () => {
    const md =
      "Accepted records from LIVE memory:\n" +
      "- [accepted][NT:notes/a.md] " +
      "Alpha runs long enough to force a cut in this segment. ".repeat(6) +
      "\n\n" +
      "Pending / unconfirmed (retrieved, not accepted):\n" +
      "- [pending][NT:notes/b.md] Beta is short.";
    // 600, not 400: below `min_share * n` the budgeter deliberately falls back to a
    // single global cut (a per-item share too small to hold a citation plus evidence is
    // not fairness, it is two markers). That fallback is existing, intended behaviour
    // and is not what this test is about.
    const out = budget(md, 600, home);
    expect(out).toContain("Pending / unconfirmed (retrieved, not accepted):");
    expect(segments(out).length).toBe(2);
  });
});
