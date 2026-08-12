import {
  extractNeedleIntents,
  extractNeedles,
  computeEvidencePointer,
  parsePointerFires,
  type TurnOffer,
} from "../../src/lib/evidence-pointer";

// G1's read-intent gate (notes/20260810-did-mla-help-session-06e2aec1-two-ledgers-one-turn-
// opposite-verdicts.md, review correction 2).
//
// THE QUESTION THE REVIEW ASKED: can a `matched_on:"path"` fire represent something other
// than read intent -- `git add notes/x.md`, `rm notes/x.md`, a commit -- an operation that
// merely NAMES the file rather than trying to consume it?
//
// MEASURED ANSWER: partly. `git add`, `rm`, `git status` and `git commit` were never a risk,
// because `extractNeedles` only tokenizes segments headed by an inspection verb and none of
// those are on the list. But `git log|show|blame|diff` ARE on it, and 3 of the 15 path fires
// on record came from exactly there:
//
//   git diff --stat -- 20260809-did-mla-help-session-a12f4682-...md
//   git diff --stat -- 20260809-did-mla-help-session-1fabf74b-...md
//   git status --short <note>.md; git log --oneline -1 -- <note>.md
//
// Each of those is an agent inspecting the version-control state of a note IT WAS WRITING.
// The document's bytes were never consumed. Counting them as engagement would let a
// self-audit note earn a `USED` for being `git diff`ed by its own author, which is this
// instrument's own named failure direction.
//
// THE FIX IS NOT A SECOND SHELL PARSER. The verb allowlist that already gates needle
// extraction IS the predicate; it was just never split. One bucket consumes the file's bytes
// (`grep`, `rg`, `cat`, `sed -n`, `head`, `tail`, and the Read/Grep tools); the other
// interrogates git metadata or tests existence (`git log|show|blame|diff`, `find`, Glob).
// The answer rides on the fire so the recap never has to re-parse a shell command.

const NOTE = "NT:notes/20260810-extraction-capacity-production-needs-none.md";
const BASE = "20260810-extraction-capacity-production-needs-none.md";

function offer(): TurnOffer {
  return {
    session_id: "s1",
    turn_index: 12,
    items: [{ source_id: NOTE, status: "accepted", text: "Extraction capacity: production needs none." }],
  };
}

function fired(toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> | null {
  const lines: string[] = [];
  const out = computeEvidencePointer("s1", toolName, toolInput, {
    readOffer: () => offer(),
    readFires: () => [],
    appendFire: (l) => lines.push(l),
    now: () => "2026-08-10T21:47:07.911Z",
  });
  if (!out) return null;
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe("read intent is classified by the verb that already gates extraction", () => {
  const reads: [string, string][] = [
    ["sed -n", `sed -n '30,60p' ${BASE}`],
    ["cat", `cat notes/${BASE}`],
    ["head", `head -c 2000 /Users/alice/projects/app/notes/${BASE}`],
    ["tail", `wc -l ${BASE} && tail -2 ${BASE}`],
    ["grep", `grep -n "absent from" notes/${BASE}`],
    ["rg", `rg "capacity" notes/${BASE}`],
  ];
  it.each(reads)("%s consumes the file, so read intent is true", (_verb, command) => {
    expect(extractNeedleIntents("Bash", { command }).some((n) => n.value.includes(BASE) && n.readIntent)).toBe(true);
  });

  const nonReads: [string, string][] = [
    ["git diff --stat", `git status --short | head -8 && git diff --stat -- ${BASE}`],
    ["git diff", `git diff -- ${BASE}`],
    ["git log", `git status --short ${BASE}; git log --oneline -1 -- ${BASE}`],
    ["git show", `git show HEAD -- ${BASE}`],
    ["git blame", `git blame ${BASE}`],
    ["find", `find . -name ${BASE}`],
  ];
  it.each(nonReads)("%s only names the file, so read intent is false", (_verb, command) => {
    const hit = extractNeedleIntents("Bash", { command }).filter((n) => n.value.includes(BASE));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((n) => n.readIntent)).toBe(false);
  });

  it("keeps the needle when a read verb and a git verb name the same file in one line", () => {
    // `git status ...; grep -c "x" <note>.md` was a real fire (session 4c50851f). The grep
    // segment consumes the file, so the line as a whole does carry read intent.
    const ns = extractNeedleIntents("Bash", { command: `git diff --stat -- ${BASE}; grep -c "x" ${BASE}` });
    expect(ns.some((n) => n.value.includes(BASE) && n.readIntent)).toBe(true);
  });

  it("classifies the inspecting TOOLS the same way", () => {
    expect(extractNeedleIntents("Read", { file_path: `/a/notes/${BASE}` })[0].readIntent).toBe(true);
    expect(extractNeedleIntents("Grep", { pattern: "capacity", path: `notes/${BASE}` }).every((n) => n.readIntent)).toBe(true);
    expect(extractNeedleIntents("Glob", { pattern: `notes/${BASE}` }).every((n) => n.readIntent)).toBe(false);
  });

  it("leaves extractNeedles' existing string[] contract alone", () => {
    const command = `sed -n '30,60p' ${BASE}`;
    expect(extractNeedles("Bash", { command })).toEqual(
      extractNeedleIntents("Bash", { command }).map((n) => n.value),
    );
  });
});

describe("the fire carries the answer so the recap never re-parses a shell command", () => {
  it("stamps read_intent true on the turn-12 sed", () => {
    const line = fired("Bash", { command: `sed -n '30,60p' ${BASE}` });
    expect(line).not.toBeNull();
    expect(line!.matched_on).toBe("path");
    expect(line!.read_intent).toBe(true);
  });

  it("stamps read_intent false on a git diff that merely names the note", () => {
    const line = fired("Bash", { command: `git diff --stat -- ${BASE}` });
    expect(line).not.toBeNull();
    expect(line!.matched_on).toBe("path");
    expect(line!.read_intent).toBe(false);
  });

  it("still fires, and still shows the excerpt, on the non-read case", () => {
    // The POINTER is unchanged: resurfacing an excerpt to an agent that is about to run
    // `git log` on the document is harmless and occasionally useful. Only the ENGAGEMENT
    // reading is narrowed. Suppressing the advisory would be a behaviour change nobody
    // measured a need for.
    const out = computeEvidencePointer(
      "s1",
      "Bash",
      { command: `git log --oneline -1 -- ${BASE}` },
      { readOffer: () => offer(), readFires: () => [], appendFire: () => {}, now: () => "t" },
    );
    expect(out).toContain(NOTE);
  });

  it("parses read_intent back off the spool, defaulting to undefined on legacy rows", () => {
    const [stamped, legacy] = parsePointerFires([
      { session_id: "s1", turn_index: 12, source_id: NOTE, tool: "Bash", matched_on: "path", read_intent: false },
      { session_id: "s1", turn_index: 12, source_id: NOTE, tool: "Bash", matched_on: "path" },
    ]);
    expect(stamped.read_intent).toBe(false);
    // Absent stays UNDEFINED here, never coerced to a boolean. The PARSER's job is to report
    // what the row says; deciding what unknown MEANS belongs to the reader, and the reader
    // (`matchPathTargetedIds`) fails closed on it. Coercing to `false` here would work today
    // and would silently hide the distinction from any future reader that wants to count how
    // many rows predate the stamp.
    expect(legacy.read_intent).toBeUndefined();
  });
});
