// Local work-product capture (P1 of the material-incorporation correlator).
// These lock the three things that make the staged capture safe to POST: the exact
// §5 digest wire shape (ids, ordering, files_metadata, completeness OR, sealed_at,
// and the deliberate OMISSION of input_digest_hash which control recomputes), the
// redaction+byte-cap of every captured piece, and the consent-gated / lenient / reaped
// on-disk store. No clock or real home is baked in: an absolute MEETLESS_HOME points
// the store at a temp dir and sealed_at / now are passed in.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ASSISTANT_OUTPUT_MAX_BYTES,
  CaptureRecord,
  HUNK_MAX_BYTES,
  MAX_HUNKS_PER_TURN,
  WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS,
  appendAssistantOutputCapture,
  appendHunkCapture,
  assembleTurnCaptures,
  buildWorkProductDigest,
  captureSessionPath,
  captureStoreDir,
  deleteSessionCapture,
  prepareContent,
  reapLocalCaptures,
  readCaptures,
} from "../../src/lib/analytics/work-product-capture";

const HOUR_MS = 60 * 60 * 1000;
const SEALED_AT = "2026-07-17T12:00:00.000Z";

function tmpEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wpc-"));
  // Absolute MEETLESS_HOME -> resolveMeetlessHome returns it verbatim (config.ts),
  // so the store lands at <dir>/work-product-capture with no real-home leakage.
  return { MEETLESS_HOME: dir, ...over } as NodeJS.ProcessEnv;
}

describe("prepareContent (redact-then-cap, both completeness signals)", () => {
  it("leaves plain text intact and flags neither signal", () => {
    const p = prepareContent("just some plain prose here", HUNK_MAX_BYTES);
    expect(p.text).toBe("just some plain prose here");
    expect(p.truncated).toBe(false);
    expect(p.redactedSubstance).toBe(false);
  });

  it("redacts a secret assignment and, when it guts the content, flags redacted_substance", () => {
    const raw = "FOO_TOKEN=" + "a".repeat(40);
    const p = prepareContent(raw, HUNK_MAX_BYTES);
    expect(p.text).not.toContain("aaaa");
    expect(p.text).toContain("[REDACTED]");
    expect(p.redactedSubstance).toBe(true);
    expect(p.truncated).toBe(false);
  });

  it("caps oversize content on a byte boundary and flags truncated", () => {
    const raw = "x".repeat(HUNK_MAX_BYTES + 500);
    const p = prepareContent(raw, HUNK_MAX_BYTES);
    expect(Buffer.byteLength(p.text, "utf8")).toBeLessThanOrEqual(HUNK_MAX_BYTES);
    expect(p.truncated).toBe(true);
    expect(p.redactedSubstance).toBe(false);
  });

  it("never splits a multibyte char at the cap boundary", () => {
    // 'é' is 2 bytes; a 5-byte cap lands mid-third-char -> the tail is dropped, not mojibake.
    const p = prepareContent("é".repeat(10), 5);
    expect(p.text).toBe("éé");
    expect(p.text).not.toContain("�");
    expect(Buffer.byteLength(p.text, "utf8")).toBeLessThanOrEqual(5);
    expect(p.truncated).toBe(true);
  });
});

describe("buildWorkProductDigest (§5 wire shape)", () => {
  const base = {
    windowStartTurn: 5,
    windowEndTurn: 8,
    captureContractVersion: 1,
    sealedAtIso: SEALED_AT,
  };

  it("emits ids, distinct files_metadata, ordering, and OMITS input_digest_hash", () => {
    const digest = buildWorkProductDigest({
      ...base,
      turns: [
        // Deliberately out of order to prove the builder sorts ascending by turn_index.
        {
          turn_index: 6,
          user_prompts: ["do the thing"],
          assistant_outputs: [{ text: "done", truncated: false, redactedSubstance: false }],
          hunks: [
            { file: "b.ts", tool: "Edit", piece: { text: "h1", truncated: false, redactedSubstance: false } },
          ],
        },
        {
          turn_index: 5,
          user_prompts: ["first", "and more"],
          assistant_outputs: [
            { text: "reply one", truncated: false, redactedSubstance: false },
            { text: "reply two", truncated: false, redactedSubstance: false },
          ],
          hunks: [
            { file: "a.ts", tool: "Edit", piece: { text: "e1", truncated: false, redactedSubstance: false } },
            { file: "a.ts", tool: "Edit", piece: { text: "e2", truncated: false, redactedSubstance: false } },
            { file: "c.ts", tool: "Write", piece: { text: "w1", truncated: false, redactedSubstance: false } },
          ],
        },
      ],
    });

    expect("input_digest_hash" in digest).toBe(false);
    expect(digest.sealed_at).toBe(SEALED_AT);
    expect(digest.window_start_turn).toBe(5);
    expect(digest.window_end_turn).toBe(8);
    expect(digest.capture_contract_version).toBe(1);

    // Ascending order regardless of input order.
    expect(digest.turns.map((t) => t.turn_index)).toEqual([5, 6]);

    const t5 = digest.turns[0];
    // Direct prompts joined into a single string.
    expect(t5.user_prompt).toBe("first\n\nand more");
    // assistant ids: first is :final, subsequent are :final-N.
    expect(t5.assistant_outputs.map((o) => o.id)).toEqual([
      "assistant:turn-5:final",
      "assistant:turn-5:final-2",
    ]);
    // hunk ids are edit-M, 1-based, in occurrence order.
    expect(t5.changed_hunks.map((h) => h.id)).toEqual([
      "hunk:turn-5:edit-1",
      "hunk:turn-5:edit-2",
      "hunk:turn-5:edit-3",
    ]);
    // files_metadata: distinct (file,tool), first-seen order (a.ts/Edit once, c.ts/Write).
    expect(t5.files_metadata).toEqual([
      { file: "a.ts", tool: "Edit" },
      { file: "c.ts", tool: "Write" },
    ]);
    expect(t5.completeness).toEqual({ truncated: false, redacted_substance: false });
  });

  it("ORs per-turn completeness across prompts, outputs, and hunks", () => {
    const digest = buildWorkProductDigest({
      ...base,
      turns: [
        {
          turn_index: 5,
          user_prompts: ["clean"],
          assistant_outputs: [{ text: "ok", truncated: false, redactedSubstance: false }],
          hunks: [
            { file: "a.ts", tool: "Edit", piece: { text: "big", truncated: true, redactedSubstance: false } },
          ],
        },
        {
          turn_index: 6,
          user_prompts: ["clean"],
          assistant_outputs: [{ text: "ok", truncated: false, redactedSubstance: true }],
          hunks: [],
        },
      ],
    });
    expect(digest.turns[0].completeness).toEqual({ truncated: true, redacted_substance: false });
    expect(digest.turns[1].completeness).toEqual({ truncated: false, redacted_substance: true });
  });

  it("caps hunks per turn and flags truncated when the list is trimmed", () => {
    const hunks = Array.from({ length: MAX_HUNKS_PER_TURN + 3 }, (_, i) => ({
      file: `f${i}.ts`,
      tool: "Edit",
      piece: { text: `h${i}`, truncated: false, redactedSubstance: false },
    }));
    const digest = buildWorkProductDigest({
      ...base,
      turns: [{ turn_index: 5, user_prompts: [], assistant_outputs: [], hunks }],
    });
    expect(digest.turns[0].changed_hunks).toHaveLength(MAX_HUNKS_PER_TURN);
    expect(digest.turns[0].completeness.truncated).toBe(true);
  });

  it("prepares raw user prompts (redacts + flags substance)", () => {
    const digest = buildWorkProductDigest({
      ...base,
      turns: [
        {
          turn_index: 5,
          user_prompts: ["FOO_TOKEN=" + "a".repeat(40)],
          assistant_outputs: [],
          hunks: [],
        },
      ],
    });
    expect(digest.turns[0].user_prompt).not.toContain("aaaa");
    expect(digest.turns[0].user_prompt).toContain("[REDACTED]");
    expect(digest.turns[0].completeness.redacted_substance).toBe(true);
  });
});

describe("capture store (consent-gated, lenient, reaped)", () => {
  it("round-trips hunks and outputs, redacting at capture time", () => {
    const env = tmpEnv();
    appendHunkCapture(
      { sessionId: "s1", turnIndex: 5, file: "a.ts", tool: "Edit", hunk: "FOO_TOKEN=" + "z".repeat(40), nowIso: SEALED_AT },
      env,
    );
    appendAssistantOutputCapture({ sessionId: "s1", turnIndex: 5, text: "all done", nowIso: SEALED_AT }, env);

    const recs = readCaptures("s1", env);
    expect(recs).toHaveLength(2);
    const hunk = recs.find((r) => r.kind === "hunk") as CaptureRecord;
    expect(hunk.hunk).not.toContain("zzzz");
    expect(hunk.hunk).toContain("[REDACTED]");
    expect(hunk.redacted_substance).toBe(true);
    const out = recs.find((r) => r.kind === "assistant_output") as CaptureRecord;
    expect(out.text).toBe("all done");
  });

  it("writes NOTHING when trace-upload consent is off", () => {
    const env = tmpEnv({ MEETLESS_TRACE_UPLOAD: "off" });
    appendHunkCapture({ sessionId: "s1", turnIndex: 5, file: "a.ts", tool: "Edit", hunk: "code" }, env);
    appendAssistantOutputCapture({ sessionId: "s1", turnIndex: 5, text: "text" }, env);
    expect(fs.existsSync(captureSessionPath("s1", env))).toBe(false);
    expect(readCaptures("s1", env)).toEqual([]);
  });

  it("reads leniently: absent file -> [], torn line skipped", () => {
    const env = tmpEnv();
    expect(readCaptures("missing", env)).toEqual([]);
    // Write one valid line and one torn line by hand.
    fs.mkdirSync(captureStoreDir(env), { recursive: true });
    const good = JSON.stringify({ session_id: "s1", turn_index: 5, kind: "hunk", ts: SEALED_AT, hunk: "ok" });
    fs.writeFileSync(captureSessionPath("s1", env), good + "\n{not valid json\n", "utf8");
    const recs = readCaptures("s1", env);
    expect(recs).toHaveLength(1);
    expect(recs[0].hunk).toBe("ok");
  });

  it("assembleTurnCaptures groups by turn in occurrence order", () => {
    const recs: CaptureRecord[] = [
      { session_id: "s1", turn_index: 5, kind: "hunk", ts: SEALED_AT, file: "a.ts", tool: "Edit", hunk: "e1" },
      { session_id: "s1", turn_index: 5, kind: "assistant_output", ts: SEALED_AT, text: "o1" },
      { session_id: "s1", turn_index: 5, kind: "hunk", ts: SEALED_AT, file: "b.ts", tool: "Write", hunk: "e2" },
      { session_id: "s1", turn_index: 6, kind: "hunk", ts: SEALED_AT, file: "c.ts", tool: "Edit", hunk: "e3" },
    ];
    const byTurn = assembleTurnCaptures(recs);
    expect(byTurn.get(5)!.hunks.map((h) => h.piece.text)).toEqual(["e1", "e2"]);
    expect(byTurn.get(5)!.assistant_outputs.map((o) => o.text)).toEqual(["o1"]);
    expect(byTurn.get(6)!.hunks).toHaveLength(1);
  });

  it("deleteSessionCapture removes one session's file", () => {
    const env = tmpEnv();
    appendHunkCapture({ sessionId: "s1", turnIndex: 5, file: "a.ts", tool: "Edit", hunk: "code" }, env);
    expect(fs.existsSync(captureSessionPath("s1", env))).toBe(true);
    deleteSessionCapture("s1", env);
    expect(fs.existsSync(captureSessionPath("s1", env))).toBe(false);
  });

  it("reaps session files past the local TTL, keeps fresh ones", () => {
    const env = tmpEnv();
    appendHunkCapture({ sessionId: "old", turnIndex: 5, file: "a.ts", tool: "Edit", hunk: "code" }, env);
    appendHunkCapture({ sessionId: "fresh", turnIndex: 5, file: "a.ts", tool: "Edit", hunk: "code" }, env);
    const nowMs = Date.parse(SEALED_AT);
    // Age the "old" file past the TTL by backdating its mtime.
    const oldTime = (nowMs - (WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS + 1) * HOUR_MS) / 1000;
    fs.utimesSync(captureSessionPath("old", env), oldTime, oldTime);
    const freshTime = (nowMs - 1 * HOUR_MS) / 1000;
    fs.utimesSync(captureSessionPath("fresh", env), freshTime, freshTime);

    const deleted = reapLocalCaptures(env, nowMs);
    expect(deleted).toBe(1);
    expect(fs.existsSync(captureSessionPath("old", env))).toBe(false);
    expect(fs.existsSync(captureSessionPath("fresh", env))).toBe(true);
  });

  it("sanitizes a hostile session id to a single safe basename", () => {
    const env = tmpEnv();
    const p = captureSessionPath("../../etc/passwd", env);
    // Every non-[A-Za-z0-9_-] char becomes _, so the file stays inside the store dir.
    expect(path.dirname(p)).toBe(captureStoreDir(env));
    expect(path.basename(p)).toBe("______etc_passwd.jsonl");
  });
});

describe("caps are sane bounds", () => {
  it("assistant cap exceeds hunk cap (outputs are longer prose)", () => {
    expect(ASSISTANT_OUTPUT_MAX_BYTES).toBeGreaterThan(HUNK_MAX_BYTES);
  });
});
