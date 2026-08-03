// Rendering untrusted repository text at the terminal.
//
// A finding row prints values nobody in this process authored: the quoted sentence comes from a
// document, the paths come from git's name-status, the author name comes from a commit header.
// Anyone who can land a commit or edit a doc controls those bytes, which on a shared repository
// is not the person reading the row. So the row is a rendering of DATA, and these tests pin the
// one property that makes that safe: a value can change what the line SAYS, never what the
// terminal DOES and never what the screen appears to offer.
//
// Every hostile character is written as an escape, never pasted literally, so the source of this
// file stays readable in the same terminals the code is defending.

import { terminalSafe, TERMINAL_TRUNCATION_MARK } from "../../src/lib/terminal-safe";

const ESC = "\u001b";
const RLO = "\u202e"; // right-to-left override (trojan source)
const PDF = "\u202c"; // pop directional formatting
const ZWSP = "\u200b";

describe("terminalSafe", () => {
  it("passes ordinary text through untouched", () => {
    expect(terminalSafe("Files under db/migrations/ must never be edited.", 200)).toBe(
      "Files under db/migrations/ must never be edited.",
    );
  });

  it("neutralizes an ESC sequence, so a document cannot repaint the operator's screen", () => {
    // `ESC[2J` clears the screen; `ESC[1A` moves the cursor up over a line already read.
    const out = terminalSafe(`before${ESC}[2J${ESC}[1Aafter`, 200);
    expect(out).not.toContain(ESC);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("neutralizes a carriage return, so a value cannot overwrite the line in front of it", () => {
    const out = terminalSafe("harmless quote\rMINTED rule: anything goes", 200);
    expect(out).not.toContain("\r");
  });

  it("flattens a newline, so a value cannot forge a second line of the report", () => {
    // The attack this closes: a quote whose second line reads like the CLI's own next-step
    // command, pointing the operator at a different run id.
    const out = terminalSafe("real quote\n  Answer it:  mla enrich resolve --run-id attacker", 400);
    expect(out).not.toContain("\n");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("strips backspace, which erases what the reader already saw", () => {
    const out = terminalSafe("never\b\b\b\b\balways edit this", 200);
    expect(out).not.toContain("\b");
    expect(out).toContain("never");
  });

  it("strips bidi overrides, so a path cannot render as a different path than it is", () => {
    // Trojan source: an override reverses the visual order while the bytes (and the mint) keep
    // the real path. A row that renders `src/safe` for a rule scoped to `src/evil` is a lie with
    // a signature under it.
    const out = terminalSafe(`src/${RLO}evil${PDF}/x.ts`, 200);
    expect(out).not.toContain(RLO);
    expect(out).not.toContain(PDF);
    expect(out).toContain("evil");
  });

  it("strips zero-width characters, which hide text inside a value that looks short", () => {
    expect(terminalSafe(`db/${ZWSP}mig${ZWSP}rations/`, 200)).toBe("db/migrations/");
  });

  it("collapses whitespace runs so the row keeps its columns", () => {
    expect(terminalSafe("  a\t\t b   c  ", 200)).toBe("a b c");
  });

  it("truncates to the cap and SAYS it truncated", () => {
    const long = "x".repeat(500);
    const out = terminalSafe(long, 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith(TERMINAL_TRUNCATION_MARK)).toBe(true);
  });

  it("does not mark a value that fits", () => {
    expect(terminalSafe("short", 40)).toBe("short");
  });

  it("counts the cap AFTER stripping, so control padding cannot push real text off the row", () => {
    // Otherwise a value could spend its whole budget on invisible bytes and truncate the part
    // the human is being asked to judge.
    const padded = `${ESC}[0m`.repeat(20) + "the actual rule text";
    expect(terminalSafe(padded, 40)).toContain("the actual rule text");
  });

  it("returns an empty string for a value that was nothing but control characters", () => {
    // The caller decides what to do with nothing; it must not get a row of mystery whitespace.
    expect(terminalSafe(`${ESC}[2J\r\n${ZWSP}`, 40)).toBe("");
  });
});
