import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { observeNotesRule } from "../../../src/lib/rules/notes-observe";
import { selectNotesLocationDirective } from "../../../src/lib/rules/notes-rule";
import { writeScanCache, readScanCache } from "../../../src/lib/scanner/cache";
import { Directive, ScanResult, directiveId } from "../../../src/lib/scanner/types";

// Slice 3: connect the local directive scan cache to the already-built pure rule
// layer (selector + four-state evaluator + notes-path classifier) through the
// observe-only adapter. The pipeline is OBSERVE-ONLY: it always returns the empty,
// decision-free response `{}` and surfaces what it saw on an in-process
// ObservationOutcome side channel. There is no permissionDecision, no persistence,
// and no rule-language framework here: one pilot rule, end to end.
//
// These are TRUE end-to-end tests: real temp directories and the REAL notes-path
// classifier (no internal mocks), so a VIOLATION is a real "this path is under the
// real forbidden root" decision, not a stubbed verdict.

function mkRoot(): string {
  // Prefix carries letters so the per-device case probe always has something to
  // flip; the temp root IS the deepest existing dir for every target below.
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-notes-rule-"));
}

// A directive whose prose expresses the notes-location rule (notes subject +
// placement). This is exactly the shape the scanner mints into the cache.
function notesDirective(): Directive {
  const source = "CLAUDE.md";
  const text =
    "Notes and design docs MUST go in the standalone vault, never the repo notes directory.";
  return {
    id: directiveId(source, text),
    text,
    source,
    kind: "RULE",
    strength: "MUST_FOLLOW",
    attestation: "human_attested",
  };
}

// An unrelated directive that must NOT be mistaken for the notes-location rule.
function unrelatedDirective(): Directive {
  const source = "CLAUDE.md";
  const text = "Use 127.0.0.1 not localhost on macOS.";
  return {
    id: directiveId(source, text),
    text,
    source,
    kind: "RULE",
    strength: "SHOULD_FOLLOW",
    attestation: "human_attested",
  };
}

function pretool(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput });
}

// Every observe result MUST be decision-free: an exactly-empty response object and
// no permissionDecision anywhere in the structure.
function expectDecisionFree(result: { response: unknown; observation: unknown }): void {
  expect(JSON.stringify(result.response)).toBe("{}");
  expect(JSON.stringify(result)).not.toMatch(/permissionDecision/);
  expect(JSON.stringify(result)).not.toMatch(/"decision"/);
}

describe("observeNotesRule: scan cache -> rule layer -> observe-only outcome", () => {
  it("observes a VIOLATION for a Write inside the forbidden notes dir, response {}", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: pretool("Write", { file_path: path.join(root, "notes", "design.md") }),
        directives: [notesDirective(), unrelatedDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({
        kind: "OBSERVED",
        result: "VIOLATION",
        reasonCode: "FORBIDDEN_PATH_MATCH",
      });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes COMPLIANT for a Write outside the forbidden notes dir, response {}", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: pretool("Write", { file_path: path.join(root, "src", "design.md") }),
        directives: [notesDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({
        kind: "OBSERVED",
        result: "COMPLIANT",
        reasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
      });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("observes UNKNOWN for an uncanonicalizable target, never a verdict, response {}", async () => {
    const root = mkRoot();
    try {
      // A NUL byte makes the path uncanonicalizable -> INDETERMINATE -> UNKNOWN.
      // It still ends with .md so the selector matches it (selection is not the
      // uncertainty; canonicalization is). Built with an explicit NUL char code so
      // the byte is unambiguous in source and preserved verbatim in the field.
      const nul = String.fromCharCode(0);
      const filePath = `${root}${path.sep}notes${path.sep}${nul}bad.md`;
      const result = await observeNotesRule({
        rawStdin: pretool("Write", { file_path: filePath }),
        directives: [notesDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({
        kind: "OBSERVED",
        result: "UNKNOWN",
        reasonCode: "CANONICALIZATION_FAILED",
      });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps malformed hook JSON to INFRA (never a violation), response {}", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: "{ this is not json",
        directives: [notesDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation.kind).toBe("INFRA");
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats Edit exactly like Write (VIOLATION inside the forbidden notes dir)", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: pretool("Edit", { file_path: path.join(root, "notes", "edit-me.md") }),
        directives: [notesDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({
        kind: "OBSERVED",
        result: "VIOLATION",
        reasonCode: "FORBIDDEN_PATH_MATCH",
      });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores Bash (not a file-writing tool) as NOT_APPLICABLE, response {}", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: pretool("Bash", { command: "rm -rf notes" }),
        directives: [notesDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({ kind: "NOT_APPLICABLE" });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is NOT_APPLICABLE when the workspace declares no notes-location rule", async () => {
    const root = mkRoot();
    try {
      const result = await observeNotesRule({
        rawStdin: pretool("Write", { file_path: path.join(root, "notes", "design.md") }),
        directives: [unrelatedDirective()],
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({ kind: "NOT_APPLICABLE" });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the notes-location rule out of a real persisted scan cache (FS round-trip)", async () => {
    const root = mkRoot();
    const home = mkRoot();
    const workspaceId = "ws-notes-observe";
    try {
      const scan: ScanResult = {
        schemaVersion: 1,
        workspaceId,
        commitSha: "deadbeef",
        generatedAt: "2026-06-18T00:00:00.000Z",
        inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
        directives: [unrelatedDirective(), notesDirective()],
        staleSignals: [],
        confirmedRulesXml: "",
        floorRulesXml: "",
        staleContextXml: "",
        advisoryDirectives: [],
      };
      writeScanCache(home, workspaceId, scan);

      const loaded = readScanCache(home, workspaceId);
      expect(loaded).not.toBeNull();

      const result = await observeNotesRule({
        rawStdin: pretool("Write", { file_path: path.join(root, "notes", "from-cache.md") }),
        directives: loaded!.directives,
        runtimeProjectRoot: root,
      });
      expect(result.observation).toEqual({
        kind: "OBSERVED",
        result: "VIOLATION",
        reasonCode: "FORBIDDEN_PATH_MATCH",
      });
      expectDecisionFree(result);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("selectNotesLocationDirective: tight pilot selection", () => {
  it("selects the notes-location directive and ignores unrelated rules", () => {
    const picked = selectNotesLocationDirective([unrelatedDirective(), notesDirective()]);
    expect(picked?.text).toBe(notesDirective().text);
  });

  it("returns null when no directive expresses the notes-location rule", () => {
    expect(selectNotesLocationDirective([unrelatedDirective()])).toBeNull();
  });

  it("does not match a bare unrelated mention of the word notes", () => {
    const distractor: Directive = {
      ...unrelatedDirective(),
      text: "Add release notes to every changelog entry.",
    };
    expect(selectNotesLocationDirective([distractor])).toBeNull();
  });
});
