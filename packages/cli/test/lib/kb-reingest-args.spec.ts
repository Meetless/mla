import { parseKbReingestArgs } from "../../src/commands/kb_reingest";

// Behavioral lock for `mla kb reingest` flag parsing after the slice-A cutover.
//
// A reingest is the SAME governed UPSERT delivery as `mla kb add`; it takes a
// reference to an EXISTING governed document (kbdoc:<id> | note:<eoid> | bare
// path) plus a small set of value flags. The notable cutover change locked here:
// `--path` (the old combined move-then-reingest) is GONE. Move is a blocked
// capability in slice A (governed identity is the source tuple; re-pathing means
// a new document, and there is no redirect primitive yet), so `--path` must be
// rejected as an unknown flag rather than silently accepted.

describe("parseKbReingestArgs", () => {
  it("requires exactly one positional input", () => {
    expect(() => parseKbReingestArgs([])).toThrow(/requires a positional input/i);
  });

  it("rejects a second positional input", () => {
    expect(() => parseKbReingestArgs(["kbdoc:a", "kbdoc:b"])).toThrow(
      /exactly one positional input/i,
    );
  });

  it("parses the kbdoc identity form with no flags", () => {
    expect(parseKbReingestArgs(["kbdoc:abc123"])).toEqual({
      input: "kbdoc:abc123",
      workspace: undefined,
      profile: undefined,
      ingestRunId: undefined,
      reason: undefined,
      agentSession: undefined,
    });
  });

  it("parses note: and bare-path identity forms", () => {
    expect(parseKbReingestArgs(["note:notes/foo.md"]).input).toBe("note:notes/foo.md");
    expect(parseKbReingestArgs(["notes/foo.md"]).input).toBe("notes/foo.md");
  });

  it("parses every supported value flag", () => {
    const flags = parseKbReingestArgs([
      "kbdoc:abc123",
      "--workspace",
      "ws_1",
      "--profile",
      "markdown_atomic_v1",
      "--ingest-run-id",
      "run_9",
      "--reason",
      "refresh after edit",
      "--agent-session",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(flags).toEqual({
      input: "kbdoc:abc123",
      workspace: "ws_1",
      profile: "markdown_atomic_v1",
      ingestRunId: "run_9",
      reason: "refresh after edit",
      agentSession: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects --path: move is a blocked capability in slice A", () => {
    expect(() => parseKbReingestArgs(["kbdoc:abc123", "--path", "notes/new.md"])).toThrow(
      /Unknown flag: --path/,
    );
  });

  it("rejects any other unknown flag", () => {
    expect(() => parseKbReingestArgs(["kbdoc:abc123", "--posture", "ACCEPTED"])).toThrow(
      /Unknown flag: --posture/,
    );
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseKbReingestArgs(["kbdoc:abc123", "--workspace"])).toThrow(
      /Missing value for --workspace/,
    );
  });

  it("rejects a value flag whose value is the next flag", () => {
    expect(() => parseKbReingestArgs(["kbdoc:abc123", "--workspace", "--reason"])).toThrow(
      /Missing value for --workspace/,
    );
  });
});
