import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// DETERMINISTIC REQUEST EXTRACTION for `user_goal`.
//
// THE DEFECT THIS LOCKS DOWN. record_session_turn stored `goal="${goal:0:400}"`:
// the first 400 characters of the (redacted) prompt, called a goal. On An's real
// prompt shape -- a short instruction paragraph followed by `---` and a pasted
// 17KB review document, or the same two in the other order -- that prefix is the
// document's first paragraph, cut mid-word. Measured on the live ledger
// 2026-08-06: 179 of 388 stored goals (46%) were at the 400-char cap, ended
// mid-sentence, spanned multiple lines, or opened with a markdown heading.
//
// Then intel's session_local provider renders it verbatim as
// `Prior session turn N (outcome: applied). Goal: <that prefix>` and injects it
// as evidence, so every downstream consumer inherits the defect. The item served
// into session 5734f9de turn 8 was, verbatim:
//
//   Goal: # Verdict **Implementation is correct... but the
//
// A prefix of a document is not a goal. The fix is extraction, not truncation:
// find the operator's actual REQUEST, bounded at a complete sentence or line, or
// emit nothing at all.
//
// THE FIXTURE. `reviewPromptShape()` reproduces the shape of the real 17,685-char
// prompt An sent in session 1f09c54b (2026-07-11), which is the canonical case:
//
//   <one paragraph of context>
//   <the actual instruction, first sentence "Help me review the proposal(s).",
//    followed by six standing constraints>
//   ---
//   <~17KB of pasted review document: headings, fences, tables, quotes, links>
//
// Every adversarial feature in the assertions below is present in that real
// prompt, including the `Review coverage: 8 / 11` line that sits inside a ```text
// fence and is the ONLY sentence-initial "Review" in the whole pasted document.
//
// Nothing is mocked. The extractor is bash + awk in common.sh and runs on the hot
// path with no node spawn; these specs exercise it exactly as the hook does.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");

function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mla-goal-home-"));
  fs.mkdirSync(path.join(h, "queue"), { recursive: true });
  return h;
}

/** Run one snippet against a sourced common.sh with an isolated MEETLESS_HOME. */
function inCommon(snippet: string, env: Record<string, string> = {}, home?: string): string {
  const h = home ?? tmpHome();
  const r = spawnSync("bash", ["-c", `source "${COMMON}" >/dev/null 2>&1; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: h, MEETLESS_DEBUG: "0", ...env },
  });
  if (!home) fs.rmSync(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  return (r.stdout || "").replace(/\n+$/, "");
}

/**
 * Extract a goal from `text`. The text goes through a temp FILE, never through
 * the shell command line: the fixture is 17KB and embedding it in `bash -c`
 * would test our quoting, not the extractor.
 */
function extractGoal(text: string, env: Record<string, string> = {}): string {
  const f = path.join(os.tmpdir(), `mla-goal-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, text);
  try {
    return inCommon(`extract_user_goal "$(cat ${JSON.stringify(f)})"`, env);
  } finally {
    fs.rmSync(f, { force: true });
  }
}

/**
 * The real prompt shape: context paragraph, instruction paragraph, horizontal
 * rule, then a pasted review document padded to ~17KB with every markdown
 * construct the extractor has to refuse to read a request out of.
 */
function reviewPromptShape(): string {
  const head = [
    "From reviewing qodo, we learn that they have something call rule health. I am not a fan of it because our rules are curated by users, so decaying them over time don't make sense. ",
    "",
    "Help me review the proposal(s). Avoid over engineering. Keep it clean and simple. Extensible. Don't paint ourselves into the corner. Review for all phases. Do not make up new gating flags. ",
    "",
    "---",
    "",
    "## Verdict",
    "",
    "**Reject this proposal as written. Do not implement it.**",
    "",
    "Your instinct is correct: a human-approved rule does not become less valid because time passed.",
    "",
    "> Rules are curated by users. Please treat that as the controlling constraint.",
    "",
    "| Signal | Meaning | Action |",
    "| --- | --- | --- |",
    "| Review coverage | how much was reviewed | Implement a denominator |",
    "",
    "Any rate must show its denominator and review coverage. For example:",
    "",
    "```text",
    "False-positive rate among reviewed interventions: 2 / 8",
    "Review coverage: 8 / 11",
    "```",
    "",
    'Do not headline "75% effective." That number would be dishonest.',
    "",
    "    Investigate the decay curve before trusting it.",
    "",
  ];

  // Pad to the real prompt's ~17KB with document prose that must never be
  // mistaken for a request. Each block repeats a heading + paragraphs.
  const body: string[] = [];
  for (let i = 1; body.join("\n").length < 16000; i++) {
    body.push(
      `### Section ${i}: enforcement evidence`,
      "",
      `Rule ${i} was applied in ${i} interventions and reversed in none of them. The proposal`,
      "would decay it anyway, which is the part that does not survive contact with how these",
      "rules are actually curated. Nothing about elapsed time makes a ratified rule less true.",
      "",
    );
  }

  const tail = [
    "The proposal's strongest idea is not \"rule health.\" It is protecting the integrity of",
    "shared user-approved rules by identifying actual conflicts. Build that. Delete the rest.",
    "",
    '[1]: https://www.qodo.ai/blog/introducing-qodo-rule-system/ "Introducing Qodo Rule System"',
    "",
  ];

  return [...head, ...body, ...tail].join("\n");
}

describe("extract_user_goal: deterministic request extraction", () => {
  const fixture = reviewPromptShape();

  it("the fixture actually reproduces the real prompt shape (>15KB, one rule, adversarial blocks)", () => {
    expect(fixture.length).toBeGreaterThan(15000);
    // Exactly one horizontal rule, so "the section after the rule" is unambiguous.
    expect(fixture.split("\n").filter((l) => /^ {0,3}-{3,} *$/.test(l))).toHaveLength(1);
    // The pasted document's ONLY sentence-initial "Review" lives inside a fence.
    expect(fixture).toContain("Review coverage: 8 / 11");
  });

  it("extracts the operator's request, not the prompt prefix", () => {
    expect(extractGoal(fixture)).toBe("Help me review the proposal(s).");
  });

  it("does not select the review heading", () => {
    const g = extractGoal(fixture);
    expect(g).not.toContain("Verdict");
    expect(g.trimStart().startsWith("#")).toBe(false);
  });

  it("does not select trailing operational constraints", () => {
    const g = extractGoal(fixture);
    for (const c of [
      "Avoid over engineering",
      "Keep it clean and simple",
      "Don't paint ourselves",
      "Do not make up new gating flags",
      "Do not headline",
    ]) {
      expect(g).not.toContain(c);
    }
  });

  it("never returns the first N characters of the prompt", () => {
    const g = extractGoal(fixture);
    expect(fixture.startsWith(g)).toBe(false);
    expect(g).not.toContain("From reviewing qodo");
  });

  it("bounds at a complete sentence: no mid-word or mid-sentence cut", () => {
    const g = extractGoal(fixture);
    expect(g).toMatch(/[.!?]$/);
    expect(g.length).toBeLessThanOrEqual(400);
  });

  it("ignores code fences, tables, quotes, headings and link-only lines as candidates", () => {
    // Same document, but with the operator's instruction removed entirely: every
    // remaining "Review"/"Implement"/"Please" sits inside a construct that is not
    // a request, so there is nothing confident left to extract.
    const noRequest = fixture.replace(/^Help me review the proposal\(s\)\..*$/m, "Some context about the proposal.");
    const g = extractGoal(noRequest);
    expect(g).not.toContain("Review coverage");
    expect(g).not.toContain("Implement a denominator");
    expect(g).not.toContain("Please treat that");
    expect(g).not.toContain("Investigate the decay curve");
    expect(g).not.toContain("qodo.ai");
  });

  it("prefers the instruction section AFTER a horizontal rule when that is where it is", () => {
    const inverted = [
      "## Prior analysis",
      "",
      "The measurement stands. Build that. Delete the rest.",
      "",
      "---",
      "",
      "Review and implement the proposal with the following decisions. Do not add an LLM.",
      "",
      "Stay on the main branch. Commit frequently.",
    ].join("\n");
    expect(extractGoal(inverted)).toBe("Review and implement the proposal with the following decisions.");
  });

  it("takes the FIRST direct request in the section, not the last imperative in the prompt", () => {
    const p = ["Help me review the proposal(s). Review for all phases.", "", "Implement the fix afterwards."].join("\n");
    expect(extractGoal(p)).toBe("Help me review the proposal(s).");
  });

  it("prefers an explicit request over a standing constraint that precedes it", () => {
    const p = "Do not over engineer. Never add a gating flag. Please review the enrichment router.";
    expect(extractGoal(p)).toBe("Please review the enrichment router.");
  });

  it("emits nothing when no confident request exists", () => {
    expect(extractGoal("# Verdict\n\n**Implementation is correct.** The workstream is code-complete.")).toBe("");
    expect(extractGoal("---\n\n| a | b |\n| - | - |\n")).toBe("");
    expect(extractGoal("```\nrm -rf /tmp/x\n```")).toBe("");
    expect(extractGoal("Thanks!")).toBe("");
  });

  it("falls back to a plain imperative only when no explicit request form exists anywhere", () => {
    expect(extractGoal("Fix the flaky enrichment timeout. Do not raise the budget.")).toBe(
      "Fix the flaky enrichment timeout.",
    );
    // ...but an explicit form anywhere in the prompt outranks a later imperative.
    expect(extractGoal("Please look at the router.\n\n---\n\nFix the flaky timeout.")).toBe(
      "Please look at the router.",
    );
  });

  it("strips list markers and emphasis but keeps the sentence intact", () => {
    expect(extractGoal("- **Please review** the ledger writer.")).toBe("Please review the ledger writer.");
    expect(extractGoal("1. Implement the extractor.")).toBe("Implement the extractor.");
  });

  it("drops an over-long 'sentence' rather than cutting it", () => {
    const runOn = "Please " + "and ".repeat(200) + "do it.";
    expect(runOn.length).toBeGreaterThan(400);
    expect(extractGoal(runOn)).toBe("");
  });

  it("survives the non-ASCII an operator actually types (macOS awk multibyte abort)", () => {
    // macOS ships BWK awk, which in a UTF-8 locale kills the WHOLE program on the
    // first character it cannot convert ("awk: towc: multibyte conversion failure"),
    // rc=2, stdout empty. An types curly quotes and em dashes, so before LC_ALL=C
    // this returned "" on both real 17KB prompts -- the extractor failed silently on
    // exactly the inputs it exists for, and looked like "no confident request".
    const curly = [
      "Help me review the proposal(s). Avoid over engineering.",
      "",
      "---",
      "",
      "## Verdict",
      "",
      "The proposal’s “living rules” model — imported wholesale — does not survive contact",
      "with how these rules are curated. «Non-ASCII» prose: café, naïve, 中文, ✅.",
    ].join("\n");
    expect(extractGoal(curly)).toBe("Help me review the proposal(s).");
    // And when the request itself carries non-ASCII, it comes back byte-intact.
    expect(extractGoal("Please review the café “living rules” proposal.")).toBe(
      "Please review the café “living rules” proposal.",
    );
  });

  // The three classes below were each found by running the extractor over 80 real
  // prompts from this machine's transcripts, not by imagining failure modes.
  describe("defects measured on 80 real prompts", () => {
    it("does not read an identifier as an imperative verb", () => {
      // `install_failure`, `trace_evals`, `audit_runs`, `create_trace_attributes`,
      // `AUDIT_EXIT` all matched a T3 verb followed by `_`. Report lines from a
      // pasted summary became the session's stated goal.
      expect(extractGoal("install_failure 28.6% (2 of 7).")).toBe("");
      expect(extractGoal("trace_evals counts: ask 320, ask_agentic 609.")).toBe("");
      expect(extractGoal("audit_runs latest is id 25 with 0 traces.")).toBe("");
      expect(extractGoal("create_trace_attributes drops None-valued fields.")).toBe("");
      expect(extractGoal("AUDIT_EXIT=0 on the last run.")).toBe("");
      // ...while the real verb still matches when it is a real word.
      expect(extractGoal("Install the missing dependency.")).toBe("Install the missing dependency.");
    });

    it("refuses escaped pasted data whose 'lines' are literal backslash-n", () => {
      const pasted = String.raw`Document-level corrections\n\n## 1.1 Reconcile the item count\n\nThe document says it covers all 19 items.`;
      expect(extractGoal(pasted)).toBe("");
      // The same prompt with a real request alongside still yields the request.
      expect(extractGoal(`${pasted}\n\nPlease reconcile the count.`)).toBe("Please reconcile the count.");
    });

    it("refuses an elided or one-word fragment", () => {
      expect(extractGoal("Fix...")).toBe("");
      expect(extractGoal("Go!")).toBe("");
      expect(extractGoal("Review the ledger writer.")).toBe("Review the ledger writer.");
    });
  });

  it("treats a setext underline as a heading, not a section rule", () => {
    // `Verdict` + `-------` is an h2, so the text above the dashes is a heading and
    // the dashes do not open a new section. Without the guard, "Verdict" would be
    // the last section's only prose line.
    const p = ["Please review the proposal.", "", "Verdict", "-------", "", "Approved."].join("\n");
    expect(extractGoal(p)).toBe("Please review the proposal.");
  });
});

describe("record_session_turn: the ledger stores the extracted goal", () => {
  const SID = "goal-ledger-session";

  function rowsAfter(promptText: string): Array<Record<string, unknown>> {
    const home = tmpHome();
    const f = path.join(home, "prompt.txt");
    fs.writeFileSync(f, promptText);
    inCommon(`record_session_turn "${SID}" 1 "${SID}:1" "$(cat ${JSON.stringify(f)})"`, {}, home);
    const p = path.join(home, "queue", `${SID}.turns`);
    const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("stores the request, not the first 400 characters", () => {
    const rows = rowsAfter(reviewPromptShape());
    expect(rows).toHaveLength(1);
    expect(rows[0].user_goal).toBe("Help me review the proposal(s).");
  });

  it("still records the turn with an EMPTY goal when no request is found", () => {
    // The row must survive: `touched_files` / `outcome` are attached at collect
    // time and are the part of a session-local item that was actually useful.
    const rows = rowsAfter("# Verdict\n\n**Implementation is correct.**");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_goal).toBe("");
    expect(rows[0].turn_id).toBe(`${SID}:1`);
    expect(rows[0].sequence).toBe(1);
  });

  it("writes no row at all when there is no prompt text", () => {
    expect(rowsAfter("")).toHaveLength(0);
  });
});
