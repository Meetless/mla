// utf8_cut_bytes in common.sh: cut to a BYTE budget without splitting a character,
// in ANY locale.
//
// WHY THIS EXISTS, measured 2026-08-06. The hook budgets its injected context against
// the host's inline-context ceiling, and that budget has to be enforced in bytes. But
// bash's slicing operator answers a different question depending on the environment:
// `${s:0:N}` takes CHARACTERS under a UTF-8 locale and BYTES under C. The C reading
// cuts mid-sequence. Over 60 consecutive cut points on Vietnamese evidence, 14 (23%)
// produced invalid UTF-8, which `jq --arg` then has to mangle or reject. Under a UTF-8
// locale the same sweep split nothing, which is precisely why this class of defect
// ships: it is invisible on the machine you wrote it on.
//
// It is ALSO why one end-to-end assertion is not enough. A single cut point catches a
// 23%-rate defect one time in four; the naive slice passed the end-to-end spec on the
// first fixture tried. This sweeps a contiguous byte range so every alignment inside a
// multibyte sequence is hit, and it drives the REAL function rather than a copy.
//
// Vietnamese is 72.7% of production traffic, so this is the common path, not an edge.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

// One bash invocation per locale, looping internally: 60 spawns would dominate the
// runtime of a test whose subject is a string operation.
const SWEEP = `
source "$COMMON_SH" >/dev/null 2>&1
text="$(cat)"
for (( b = $1; b <= $2; b++ )); do
  printf '%s\\0' "$(utf8_cut_bytes "$text" "$b")"
done
`;

// Two-byte (Vietnamese), three-byte (CJK) and four-byte (astral) sequences, so the
// sweep crosses every UTF-8 sequence length rather than only the common one.
const TEXT =
  "## Bằng chứng đã truy xuất từ bộ nhớ được quản trị 決定事項 🔎:\n" +
  Array.from(
    { length: 120 },
    (_, i) => `- quyết định ${i}: đã phê duyệt điều khoản triển khai 決定 🚀 [NT:notes/x${i}.md]`,
  ).join("\n");

function sweep(locale: string, lo: number, hi: number, home: string): Buffer[] {
  const out = execFileSync("bash", ["-c", SWEEP, "mla-utf8-cut", String(lo), String(hi)], {
    input: TEXT,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", COMMON_SH, LC_ALL: locale, LANG: locale },
  });
  // NUL-delimited so a cut result containing newlines cannot be mistaken for a record
  // boundary. The trailing empty element after the final delimiter is dropped.
  const parts = out.toString("binary").split("\0");
  parts.pop();
  return parts.map((p) => Buffer.from(p, "binary"));
}

function isValidUtf8(b: Buffer): boolean {
  return Buffer.from(b.toString("utf8"), "utf8").equals(b);
}

describe("utf8_cut_bytes (common.sh): a byte budget that never splits a character", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-utf8cut-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  // A contiguous range wide enough that every offset within a 2-, 3- and 4-byte
  // sequence is exercised, positioned inside the body rather than at either end.
  const LO = 2960;
  const HI = 3020;

  for (const locale of ["C", "en_US.UTF-8"]) {
    describe(`LC_ALL=${locale}`, () => {
      it("never exceeds the byte budget", () => {
        const outs = sweep(locale, LO, HI, home);
        expect(outs).toHaveLength(HI - LO + 1);
        outs.forEach((b, i) => {
          expect(b.length).toBeLessThanOrEqual(LO + i);
        });
      });

      it("never emits invalid UTF-8", () => {
        const bad = sweep(locale, LO, HI, home)
          .map((b, i) => ({ budget: LO + i, b }))
          .filter(({ b }) => !isValidUtf8(b));
        expect(bad.map((x) => x.budget)).toEqual([]);
      });

      it("never drops more than one sequence (4 bytes) below the budget", () => {
        // The repair walks back at most one sequence. A cut that lost more than that
        // would mean the walk-back is eating valid characters, which costs evidence
        // silently rather than failing loudly.
        const outs = sweep(locale, LO, HI, home);
        outs.forEach((b, i) => {
          expect(LO + i - b.length).toBeLessThanOrEqual(4);
        });
      });
    });
  }

  it("is a no-op when the text already fits", () => {
    const short = execFileSync("bash", ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; utf8_cut_bytes "$(cat)" 100000'], {
      input: TEXT,
      env: { ...process.env, MEETLESS_HOME: home, COMMON_SH },
    });
    expect(short.toString("utf8")).toBe(TEXT);
  });

  it("is total on a zero and a negative budget", () => {
    for (const budget of ["0", "-5"]) {
      const out = execFileSync("bash", ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; utf8_cut_bytes "$(cat)" "$1"', "x", budget], {
        input: TEXT,
        env: { ...process.env, MEETLESS_HOME: home, COMMON_SH },
      });
      expect(out.length).toBe(0);
    }
  });
});
