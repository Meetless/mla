// E21/E22: the evidence budgeter must count its own items, and a bigger budget must
// never deliver fewer documents.
//
// THE DEFECT (notes/20260809-mla-helpfulness-session-a4a779b2-the-budgeter-miscounts-its-own-items.md
// H1). `budget_evidence_markdown` segmented a rendered evidence block by the glob
// `'- ['`. The four shapes intel's `_render_enrichment_markdown` actually emits are
// `- [accepted]`, `- [pending]`, `- [shadow]` and `- [agent-observation]`, each
// optionally followed by `[<source_id>]`. But a GitHub-flavoured markdown checkbox
// (`- [x]`, `- [ ]`) and a markdown link bullet (`- [text](url)`) match that same glob,
// and a retrieved note is arbitrary markdown, so its BODY routinely contains both.
//
// Session a4a779b2 turn 3: three documents were selected, the third was a to-do list,
// and the segmenter saw FIFTEEN items where there were three. `reserve = max / n` then
// cut every real item's allowance by 5x, twelve phantom segments each held a
// reservation they spent on a 40-byte checkbox line, and the `max / n < min_share`
// guard could not fire because it is evaluated against the same inflated n. One
// document reached the model, and it was the irrelevant one. Every instrument
// (`selected_count: 3`, `context_items[*].injected: true`, `layer2_injected: true`)
// reported a three-document success.
//
// Measured over every evidence payload on that machine: 441 of 948 (46.5%) contained
// more `- [` lines than real items. That prevalence is LOCAL to one operator's corpus;
// it is not a claim about the MLA population.
//
// These drive the REAL bash functions in common.sh, not a copy.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");
const MARKER = "[...truncated by Meetless...]";
// The REAL evidence block from session a4a779b2 turn 3, byte for byte, lifted from that
// turn's sidecar (`~/.meetless/logs/enrichments/8ca48ccd....md`, everything under the
// `## Layer 2 enrichment` heading, which is exactly what the hook hands the budgeter).
//
// Byte-exact ON PURPOSE and NOT to be reformatted: the inversions below sit at specific
// budgets, and those budgets are a function of where the paragraph, line and sentence
// boundaries fall in this text. A tidied fixture moves them and quietly turns the sweep
// green. A synthetic reconstruction was tried first and did NOT reproduce the inversion.
const FIXTURE = join(__dirname, "..", "fixtures", "evidence-block-turn3-a4a779b2.md");

function bash(script: string, args: string[], input: string, home: string): string {
  return execFileSync("bash", ["-c", script, "mla-e21", ...args], {
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

/** Run the real `count_evidence_items` over a payload. */
function itemCount(md: string, home: string): number {
  return Number(
    bash('source "$COMMON_SH" >/dev/null 2>&1; count_evidence_items "$(cat)"', [], md, home).trim(),
  );
}

/**
 * Sweep the REAL `budget_evidence_markdown` across a budget range inside ONE bash
 * process, reporting `<budget> <delivered-documents> <bytes>` per line.
 *
 * One subprocess, not one per budget: the audit's own sweep was ~7,400 budgets and a
 * per-budget `execFileSync` would be ~7,400 node+bash spawns for a function that costs
 * microseconds. Same production function, same arguments, 1/7400th of the process cost.
 */
function sweep(md: string, lo: number, hi: number, step: number, home: string): { max: number; docs: number; bytes: number }[] {
  const out = bash(
    [
      'source "$COMMON_SH" >/dev/null 2>&1',
      'md="$(cat)"',
      // Byte length WITHOUT a subshell (`BL=` rather than a `$( )` capture): at step 1
      // this loop runs 1,601 times and every avoidable fork is 1,601 forks.
      "BL=0",
      "bl() { local LC_ALL=C; BL=${#1}; }",
      'for (( b = $1; b <= $2; b += $3 )); do',
      '  o="$(budget_evidence_markdown "$md" "$b")"',
      // The test's OWN oracle for "a document was delivered": the item header line
      // survived. Deliberately independent of the production matcher, so a bug in that
      // matcher cannot make this sweep agree with it.
      "  c=0",
      '  while IFS= read -r l; do case "$l" in "- [pending]["*) c=$(( c + 1 ));; esac; done <<< "$o"',
      '  bl "$o"',
      '  printf "%d %d %d\\n" "$b" "$c" "$BL"',
      "done",
    ].join("\n"),
    [String(lo), String(hi), String(step)],
    md,
    home,
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [max, docs, bytes] = l.trim().split(/\s+/).map(Number);
      return { max, docs, bytes };
    });
}

/** The real turn-3 payload: three documents, the third a markdown to-do list. */
function realPayload(): string {
  return readFileSync(FIXTURE, "utf8");
}

// The three documents intel selected that turn, in order. `20260804-did-mla-help...` is
// the one that answered the prompt and the one that was dropped.
const DOC1 = "NT:notes/20260518-ask-pipeline-sota-overhaul-proposal-and-review.md";
const DOC2 = "NT:notes/20260804-did-mla-help-session-audit-and-fix-proposal.md";
const DOC3 = "NT:notes/20260624-notes.md";

describe("E21: the segmenter counts rendered evidence items, not markdown checkboxes", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-e21-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  // The count itself, against the real turn-3 shape. 15 `- [` lines, 3 documents.
  it("counts three items in the payload that was counted as fifteen", () => {
    const md = realPayload();
    expect(md.split("\n").filter((l) => l.startsWith("- [")).length).toBeGreaterThan(10);
    expect(itemCount(md, home)).toBe(3);
  });

  // Every shape the canonical renderer emits is an item, in both its forms (with and
  // without a source_id). If intel adds a band, this is the test that has to be updated
  // in the same change.
  it("recognises every band _render_enrichment_markdown emits, with and without a source id", () => {
    const bands = ["accepted", "pending", "shadow", "agent-observation"];
    for (const b of bands) {
      expect(itemCount(`- [${b}][NT:notes/a.md] body text`, home)).toBe(1);
      expect(itemCount(`- [${b}] body text`, home)).toBe(1);
    }
    expect(itemCount(bands.map((b) => `- [${b}][NT:notes/${b}.md] body`).join("\n"), home)).toBe(4);
  });

  // The three shapes that used to be counted as items. None of them is one.
  it("never counts a checkbox, a wiki-link bullet or a markdown link as an item", () => {
    const notItems = [
      "- [x] a checked to-do",
      "- [ ] an unchecked to-do",
      "- [X] a capital-X to-do",
      "- [the discovery doc](notes/20260601-discovery.md) a link bullet",
      "- [[20260623-wiki-link]] a wiki link",
      "- [TODO] not a band either",
      "- an ordinary bullet",
      "  - [pending][NT:notes/indented.md] an INDENTED line is body, not a top-level item",
    ];
    for (const line of notItems) expect(itemCount(line, home)).toBe(0);
    expect(itemCount(notItems.join("\n"), home)).toBe(0);
  });

  // THE BEHAVIOURAL CONSEQUENCE, which is the finding: at the budget the real turn ran
  // at, all three documents reach the model. Before the fix exactly one did.
  it("delivers all three documents at the 1200B floor the real turn ran at", () => {
    const out = budget(realPayload(), 1200, home);
    expect(out).toContain(DOC1);
    expect(out).toContain(DOC2);
    expect(out).toContain(DOC3);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1200);
  });

  // A checkbox inside an item body may not open a segment, which is what let twelve
  // phantom segments each hold a reservation. The band header must still never be eaten.
  it("keeps a checklist body inside its own item and never eats a band header", () => {
    const md =
      "Accepted records from LIVE memory:\n" +
      "- [accepted][NT:notes/a.md] Alpha. " +
      "Alpha runs long enough to force a cut in this segment. ".repeat(8) +
      "\n\n" +
      "Pending / unconfirmed (retrieved, not accepted):\n" +
      "- [pending][NT:notes/b.md] Beta has a checklist body:\n" +
      "- [ ] beta task one\n" +
      "- [x] beta task two\n" +
      "- [ ] beta task three";
    const out = budget(md, 800, home);
    expect(itemCount(md, home)).toBe(2);
    expect(out).toContain("Pending / unconfirmed (retrieved, not accepted):");
    expect(out).toContain("NT:notes/b.md");
  });
});

describe("E22: delivered documents never decrease as the budget grows", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-e22-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function inversionsIn(rows: { max: number; docs: number }[]): string[] {
    return rows
      .map((r, i) =>
        i > 0 && r.docs < rows[i - 1].docs ? `${rows[i - 1].max}:${rows[i - 1].docs} -> ${r.max}:${r.docs}` : "",
      )
      .filter(Boolean);
  }

  // THE INVERSION, measured on this exact fixture with the segmenter broken:
  //
  //   1200 -> 1 doc   2345 -> 2   2346 -> 1   2412 -> 2   2413 -> 1   2452 -> 2   2749 -> 3
  //
  // A larger budget delivering FEWER documents is a strict inversion of this function's
  // contract, and nothing could see it because nothing swept the budget. Two distinct
  // mechanisms produce it and BOTH need the miscount to be reachable here:
  //
  //   1. with n inflated to 15, `max / n < min_share` held up to max=3599, so every
  //      budget in this range took the SINGLE GLOBAL CUT, where `cut_at_boundary`'s
  //      rung ladder is not monotonic in its allowance: a larger allowance can clear
  //      rung 1's 50% floor and return the paragraph boundary, which is SHORTER than
  //      the line boundary a smaller allowance fell through to. That is 2346 and 2413.
  //   2. at max=3600 the per-item path finally switched on, and with twelve phantom
  //      segments each holding a reservation it delivered FEWER documents than the
  //      global cut had. (Visible at 3600 on the full sidecar; this fixture is the
  //      evidence block alone, so it shows mechanism 1.)
  //
  // With n counted correctly (3), min_share*3 = 720, so every budget the hook can
  // construct (>= 1200) takes the per-item path, every item's allowance clears its own
  // header, and the count is constant 3. Mechanism 1 still exists inside
  // `cut_at_boundary` and can still shorten a segment's BODY; it can no longer remove a
  // document, which is the invariant this pins.
  //
  // STEP 1, and a bounded range. Step 25 over the full 1200-8600 does NOT falsify on
  // this fixture (measured: it samples neither 2346 nor 2413), and step 1 over the full
  // range is ~7,400 invocations of a function that forks per segment. 1200-2800 at step
  // 1 contains both inversions and runs in ~15s.
  it("is monotonic non-decreasing at every single byte of the low budget band", () => {
    const rows = sweep(realPayload(), 1200, 2800, 1, home);
    expect(rows.length).toBe(1601);
    expect(inversionsIn(rows)).toEqual([]);
    // Not vacuous: the fix is what makes this 3, and the whole band is the SAME 3.
    expect(new Set(rows.map((r) => r.docs))).toEqual(new Set([3]));
  }, 120_000);

  // The rest of the hook's range (up to `MAX_MD`'s 8600 cap), coarsely. Cheap coverage
  // for a band the fine sweep does not reach.
  it("is monotonic non-decreasing across the rest of the hook's budget range", () => {
    const rows = sweep(realPayload(), 2800, 8600, 25, home);
    expect(inversionsIn(rows)).toEqual([]);
  }, 60_000);

  // And the endpoint is right, not merely stable: a budget large enough for everything
  // delivers everything, uncut.
  it("delivers every document, uncut, once the budget covers the payload", () => {
    const md = realPayload();
    const out = budget(md, Buffer.byteLength(md, "utf8") + 1, home);
    // `$( )` strips trailing newlines, in this harness and equally at the production
    // call site, so the fixture's own trailing newline is not part of the comparison.
    expect(out).toBe(md.replace(/\n+$/, ""));
    expect(out).not.toContain(MARKER);
  });

  // The budget stays a HARD ceiling across the whole sweep. Fixing the count must not
  // buy monotonicity by overspending.
  it("never exceeds the budget anywhere in the sweep", () => {
    for (const r of sweep(realPayload(), 1200, 8600, 97, home)) {
      expect(r.bytes).toBeLessThanOrEqual(r.max);
    }
  }, 60_000);
});
