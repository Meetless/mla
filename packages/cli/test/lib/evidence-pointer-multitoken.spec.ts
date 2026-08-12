import {
  OfferedItem,
  TurnOffer,
  isUsableNeedle,
  matchPointer,
} from "../../src/lib/evidence-pointer";

// M7 (session 4caa06b9): the PreToolUse "you already have this" pointer fired three
// times on generic literals -- `workspace`, `activate.ts`, `install.sh` -- each one
// interrupting a grep/Bash call. Two of the three were code-shape lookups, which
// CLAUDE.md explicitly routes to grep. Matching a common noun or a bare filename
// against a delivered note is not evidence the note answers the question, and this
// is an INTERRUPT-shaped surface: a false positive costs attention at the worst
// possible moment.
//
// PREMISE CHECK on current main, before writing a line of fix:
//   `workspace`   -> ALREADY suppressed. The identifier-or-path distinctiveness gate
//                    landed after the measured session, so one of the three reported
//                    false positives is already gone. Pinned below as a regression.
//   `activate.ts` -> still fires.
//   `install.sh`  -> still fires.
//
// The proposal offered three remedies: a corpus-frequency floor, a `code_shape` intent
// gate, or a multi-token rule. The intent gate is not available: `code_shape` does not
// exist anywhere in this repo, and computeEvidencePointer is handed only
// (sessionId, toolName, toolInput) at the PreToolUse decision point. A frequency floor
// needs a corpus statistic the hook does not have. So this is the multi-token rule,
// which is a pure function over the needle and adds no infrastructure at all.

function offer(items: Partial<OfferedItem>[]): TurnOffer {
  return {
    session_id: "s1",
    turn_index: 6,
    items: items.map((i) => ({
      source_id: i.source_id ?? "NT:notes/x.md",
      status: i.status ?? "pending",
      text: i.text ?? "",
    })),
  };
}

describe("M7 reproducer: the literals that actually fired", () => {
  it("rejects `activate.ts` (a bare filename is one token wearing a suffix)", () => {
    expect(isUsableNeedle("activate.ts")).toBe(false);
  });

  it("rejects `install.sh`", () => {
    expect(isUsableNeedle("install.sh")).toBe(false);
  });

  it("still rejects `workspace` (regression guard on the gate already shipped)", () => {
    expect(isUsableNeedle("workspace")).toBe(false);
  });

  it("does not point at a delivered note just because it mentions the filename", () => {
    // The measured `install.sh` fire: the offered note genuinely contained the string,
    // and the agent had already established the fact itself. A filename match is not
    // evidence the note answers the question being asked.
    const o = offer([
      {
        source_id: "NT:notes/20260710-mla-onboarding-idempotency-and-activate-autochain.md",
        text: "The curl installer install.sh contains 0 POSTs; activation happens later.",
      },
    ]);
    expect(matchPointer(o, ["install.sh"])).toBeNull();
    expect(matchPointer(o, ["activate.ts"])).toBeNull();
  });
});

describe("M7 precision: genuinely distinctive needles still point", () => {
  // The two acceptance cases the mechanism exists for must not regress. Both are
  // multi-token by construction, which is why the rule is safe to add.
  it.each([
    ["intel/app/chunking/profiles.py", "a real path"],
    ["src/lib/wire.ts", "a path, not a bare filename"],
    ["PROFILES_BY_NAME", "a screaming-snake identifier"],
    ["current_revision_id", "a snake_case identifier"],
    ["matchOpenedIds", "internal capitals, three tokens"],
    ["CoordinationCase", "internal capitals, two tokens"],
    ["retrieve_knowledge", "two substantive words"],
    ["20260609-r2-revision-backfill-plan.md", "a dated note filename"],
  ])("accepts %s (%s)", (needle) => {
    expect(isUsableNeedle(needle)).toBe(true);
  });

  it("still fires on the §2.1 acceptance case", () => {
    const o = offer([
      {
        source_id: "NT:notes/20260514-meetless-dogfood-implementation-plan-v2.md",
        text:
          "B4. Implement intel/app/knowledge/chunking/profiles.py per section 6.7. " +
          "Single profile constant MARKDOWN_ATOMIC_V1.",
      },
    ]);
    expect(matchPointer(o, ["intel/app/knowledge/chunking/profiles.py"])).not.toBeNull();
  });
});

describe("M7: a single token is a code-shape lookup, and grep owns those", () => {
  it.each([
    "isCapturable",
    "scanner.ts",
    "config.json",
    "README.md",
    "server.py",
    "profiles.py",
  ])("rejects the single-substantive-token needle %s", (needle) => {
    expect(isUsableNeedle(needle)).toBe(false);
  });

  it("does NOT try to be a code-shape classifier: a genuinely specific symbol still points", () => {
    // `runKbDocDetail` is three substantive tokens and names exactly one thing in
    // this corpus. It is also a code-shape lookup, and the rule cannot tell those
    // apart, by design: the remedy asked for was a multi-token PRECISION rule, not
    // a second classifier. The rule buys precision on generic literals and stops
    // there.
    expect(isUsableNeedle("runKbDocDetail")).toBe(true);
  });

  it("a file extension is never the second token", () => {
    // `activate` + `ts` reads as two tokens to a naive split. It is not: the extension
    // says what KIND of file it is, never which one, so it carries no distinctiveness.
    expect(isUsableNeedle("activate.ts")).toBe(false);
    expect(isUsableNeedle("activate.spec.ts")).toBe(true);
  });

  it("a very short token is never the second token either", () => {
    // `is`, `by`, `id`, `r2` are glue. Dropping them is what makes `isCapturable`
    // (one real word) fail while `current_revision_id` (two) passes.
    expect(isUsableNeedle("isCapturable")).toBe(false);
    expect(isUsableNeedle("current_revision_id")).toBe(true);
  });
});
