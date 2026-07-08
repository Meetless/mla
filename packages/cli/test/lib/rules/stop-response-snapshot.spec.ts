import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  readStopResponseSnapshot,
  selectParentAssistantText,
} from "../../../src/lib/rules/stop-response-snapshot";

// CE0 §2.3 Stage B, the PARENT_ASSISTANT_TEXT_V1 selector as a pure function over already-parsed
// transcript records (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3,
// lines 1119-1144). The selector picks the latest top-level parent assistant record in file order
// and returns its text blocks joined with a single literal newline; it excludes sidechain /
// subagent, user, system, progress, and tool-result records. An empty text array is the empty
// canonical answer (""); a window with no top-level parent assistant record returns null
// (NO_PARENT_ASSISTANT_RECORD). Records arrive in file order (oldest first); "latest" is the last
// matching record.

describe("selectParentAssistantText: the §2.3 PARENT_ASSISTANT_TEXT_V1 selector", () => {
  test("joins the latest assistant record's text blocks with a single newline, skipping non-text blocks", () => {
    const records = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first block" },
            { type: "tool_use", id: "t1", name: "x", input: {} },
            { type: "text", text: "second block" },
          ],
        },
      },
    ];
    expect(selectParentAssistantText(records)).toBe("first block\nsecond block");
  });

  test("excludes a sidechain/subagent assistant record even when it is the latest record", () => {
    const records = [
      { type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "top answer" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent answer" }] } },
    ];
    expect(selectParentAssistantText(records)).toBe("top answer");
  });

  test("excludes user, system, progress, and tool-result records that follow the assistant", () => {
    const records = [
      { type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "the answer" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "system", subtype: "info" },
      { type: "progress" },
    ];
    expect(selectParentAssistantText(records)).toBe("the answer");
  });

  test("treats an empty text array as the empty canonical answer, never skipping to an earlier record", () => {
    const records = [
      { type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "earlier" }] } },
      { type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] } },
    ];
    expect(selectParentAssistantText(records)).toBe("");
  });

  test("returns null when the window holds no top-level parent assistant record", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
    ];
    expect(selectParentAssistantText(records)).toBeNull();
  });

  test("preserves each text block exactly: no trimming, internal newlines kept", () => {
    const records = [
      {
        type: "assistant",
        isSidechain: false,
        message: {
          content: [
            { type: "text", text: "  leading and trailing  " },
            { type: "text", text: "line1\nline2" },
          ],
        },
      },
    ];
    expect(selectParentAssistantText(records)).toBe("  leading and trailing  \nline1\nline2");
  });

  test("treats a record with no isSidechain flag as a top-level parent assistant", () => {
    const records = [
      { type: "assistant", message: { content: [{ type: "text", text: "no-flag answer" }] } },
    ];
    expect(selectParentAssistantText(records)).toBe("no-flag answer");
  });
});

// CE0 §2.3 Stage B, the bounded backward transcript reader (proposal lines 1119-1149). It reads at
// most 2 MiB / 256 records from the tail of transcript_path, applies the PARENT_ASSISTANT_TEXT_V1
// selector, and emits responseHash plus a byte-exact ResponseSourceRefV1 pointer, or a stable
// unlabelable reason. It does real filesystem I/O against real temp transcripts (no fs mocks): the
// rule is "do not mock internal services", and the byte-pointer contract is only meaningful against
// real bytes on disk. It must never throw and never fail Stop.

describe("readStopResponseSnapshot: the §2.3 Stage B bounded backward reader", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ce0-stopsnap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(name: string, records: unknown[]): string {
    const p = join(dir, name);
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return p;
  }

  /** Independently rehydrate the byte pointer the way the offline exporter will: seek to the
   * recorded offset, read exactly recordByteLength bytes, verify recordSha256, re-parse, re-apply
   * the selector, and verify the recomputed responseHash. Proves the pointer is byte-exact. */
  function expectPointerRoundTrips(
    snap: ReturnType<typeof readStopResponseSnapshot>,
    expectedAnswer: string,
  ): void {
    if (!snap.ok) throw new Error(`expected ok snapshot, got reason ${snap.reason}`);
    const ref = snap.responseSourceRef;
    expect(ref.kind).toBe("CLAUDE_TRANSCRIPT_JSONL");
    expect(ref.version).toBe(1);
    expect(ref.selector).toBe("PARENT_ASSISTANT_TEXT_V1");

    const fd = openSync(ref.transcriptPath, "r");
    const buf = Buffer.allocUnsafe(ref.recordByteLength);
    readSync(fd, buf, 0, ref.recordByteLength, ref.recordByteOffset);
    closeSync(fd);

    const bytes = buf.toString("utf8");
    expect(sha256Hex(bytes)).toBe(ref.recordSha256);
    const record = JSON.parse(bytes);
    const answer = selectParentAssistantText([record]);
    expect(answer).toBe(expectedAnswer);
    expect(sha256Hex(answer ?? "")).toBe(snap.responseHash);
  }

  test("snapshots the latest top-level assistant answer with a byte-exact pointer", () => {
    const p = writeTranscript("happy.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "what changed?" }] } },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "a1",
        message: { role: "assistant", content: [
          { type: "text", text: "An earlier step." },
          { type: "tool_use", id: "t1", name: "x", input: {} },
        ] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      {
        type: "assistant",
        isSidechain: false,
        uuid: "a2",
        message: { role: "assistant", content: [
          { type: "text", text: "Final answer line one." },
          { type: "text", text: "Final answer line two." },
        ] },
      },
    ]);

    const expectedAnswer = "Final answer line one.\nFinal answer line two.";
    const snap = readStopResponseSnapshot(p);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.responseHash).toBe(sha256Hex(expectedAnswer));
    expect(snap.responseSourceRef.transcriptPath).toBe(p);
    expect(snap.responseSourceRef.recordByteOffset).toBeGreaterThan(0);
    expectPointerRoundTrips(snap, expectedAnswer);
  });

  test("an empty text array snapshots the empty canonical answer and still round-trips", () => {
    const p = writeTranscript("empty.jsonl", [
      { type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "earlier" }] } },
      { type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: "t", name: "x", input: {} }] } },
    ]);

    const snap = readStopResponseSnapshot(p);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.responseHash).toBe(sha256Hex(""));
    expectPointerRoundTrips(snap, "");
  });

  test("skips an unparseable line in the window and still finds the assistant answer", () => {
    const p = join(dir, "garbage.jsonl");
    writeFileSync(
      p,
      [
        "this is not json",
        JSON.stringify({ type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "survived" }] } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const snap = readStopResponseSnapshot(p);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.responseHash).toBe(sha256Hex("survived"));
    expectPointerRoundTrips(snap, "survived");
  });

  test("returns TRANSCRIPT_MISSING when the path does not exist", () => {
    const snap = readStopResponseSnapshot(join(dir, "nope.jsonl"));
    expect(snap).toEqual({ ok: false, reason: "TRANSCRIPT_MISSING" });
  });

  test("returns TRANSCRIPT_MISSING when no transcript path is supplied", () => {
    expect(readStopResponseSnapshot(undefined)).toEqual({ ok: false, reason: "TRANSCRIPT_MISSING" });
  });

  test("returns TRANSCRIPT_UNREADABLE when the path is not a readable file", () => {
    // The temp dir itself exists but is not a transcript file: it must not be MISSING.
    const snap = readStopResponseSnapshot(dir);
    expect(snap).toEqual({ ok: false, reason: "TRANSCRIPT_UNREADABLE" });
  });

  test("returns NO_PARENT_ASSISTANT_RECORD when the window holds no top-level parent assistant", () => {
    const p = writeTranscript("none.jsonl", [
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "system", subtype: "info" },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } },
    ]);

    expect(readStopResponseSnapshot(p)).toEqual({ ok: false, reason: "NO_PARENT_ASSISTANT_RECORD" });
  });

  test("respects the 256-record cap: an assistant beyond the last 256 records is out of the window", () => {
    const records: unknown[] = [
      { type: "assistant", isSidechain: false, message: { content: [{ type: "text", text: "buried" }] } },
    ];
    for (let k = 0; k < 300; k++) {
      records.push({ type: "user", message: { content: [{ type: "text", text: `u${k}` }] } });
    }
    const p = writeTranscript("capped.jsonl", records);

    expect(readStopResponseSnapshot(p)).toEqual({ ok: false, reason: "NO_PARENT_ASSISTANT_RECORD" });
  });
});
