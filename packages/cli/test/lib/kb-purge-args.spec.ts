import { parseKbPurgeArgs } from "../../src/commands/kb_purge";

// Behavioral lock for `mla kb purge` flag parsing after the slice-A cutover.
//
// Purge = redact EVERY revision (irreversible content removal in slice A, audit
// metadata retained) + tombstone the document. Two cutover changes locked here:
//
//   1. `--force` is GONE. The old worker took `--force` to override a §7
//      dependency-guard matrix that blocked purge on promoted/candidate edges.
//      The slice-A reshape dropped that machinery (graph slices deferred), so
//      there are no edges to force-drop; `--force` must be rejected as unknown.
//   2. `--reason` is now MANDATORY at >=16 characters. Redaction is irreversible
//      in slice A (there is no un-redact primitive), so an empty, missing, or
//      too-short reason is rejected before any side effect.

const REASON = "stale duplicate, superseded by canonical doc";

describe("parseKbPurgeArgs", () => {
  it("requires exactly one positional input", () => {
    expect(() => parseKbPurgeArgs(["--reason", REASON])).toThrow(
      /requires a positional input/i,
    );
  });

  it("rejects a second positional input", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:a", "kbdoc:b", "--reason", REASON])).toThrow(
      /exactly one positional input/i,
    );
  });

  it("parses the kbdoc identity form with a valid reason", () => {
    expect(parseKbPurgeArgs(["kbdoc:abc123", "--reason", REASON])).toEqual({
      input: "kbdoc:abc123",
      workspace: undefined,
      reason: REASON,
    });
  });

  it("parses note: and bare-path identity forms", () => {
    expect(parseKbPurgeArgs(["note:notes/foo.md", "--reason", REASON]).input).toBe(
      "note:notes/foo.md",
    );
    expect(parseKbPurgeArgs(["notes/foo.md", "--reason", REASON]).input).toBe(
      "notes/foo.md",
    );
  });

  it("parses --workspace", () => {
    const flags = parseKbPurgeArgs(["kbdoc:abc123", "--workspace", "ws_1", "--reason", REASON]);
    expect(flags).toEqual({ input: "kbdoc:abc123", workspace: "ws_1", reason: REASON });
  });

  it("requires --reason (it is mandatory: redaction is irreversible)", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123"])).toThrow(/--reason .* is required/i);
  });

  it("rejects a blank --reason", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--reason", "   "])).toThrow(
      /--reason .* is required/i,
    );
  });

  it("rejects a --reason shorter than 16 characters", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--reason", "too short"])).toThrow(
      /at least 16 characters/i,
    );
  });

  it("rejects --force: there are no edges to force-drop in slice A", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--reason", REASON, "--force"])).toThrow(
      /Unknown flag: --force/,
    );
  });

  it("rejects any other unknown flag", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--reason", REASON, "--posture", "ACCEPTED"])).toThrow(
      /Unknown flag: --posture/,
    );
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--workspace"])).toThrow(
      /Missing value for --workspace/,
    );
  });

  it("rejects a value flag whose value is the next flag", () => {
    expect(() => parseKbPurgeArgs(["kbdoc:abc123", "--reason", "--workspace"])).toThrow(
      /Missing value for --reason/,
    );
  });
});
