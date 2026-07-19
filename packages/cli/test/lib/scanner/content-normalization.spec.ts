import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_NORMALIZATION_V1,
  ContentNormalizationError,
  normalizeContent,
  normalizedContentHash,
} from "../../../src/lib/scanner/content-normalization";

// ADR test 7 (notes/20260717-adr-decision-record-projection-and-reconciliation.md,
// §8): the CLI's local normalized digest is STABLE across CRLF/BOM/Unicode-form
// differences and BYTE-EQUAL to intel's `content-normalization-v1` digest over
// the shared golden corpus. This spec re-derives every corpus vector with the
// VENDORED CLI module and asserts equality with the recorded hashes, proving the
// three copies (utils, intel, CLI) agree hash-for-hash. It also pins the
// fail-closed behavior the corpus does not carry.

interface NormalizationVector {
  label: string;
  raw: string;
  version: string;
  normalized: string;
  normalizedContentHash: string;
  rawContentHash: string;
}

const CORPUS_PATH = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "content-normalization",
  "content-normalization-corpus.json",
);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
  normalization: NormalizationVector[];
};

// e + U+0301 combining acute (NFD) vs the single U+00E9 NFC code point.
const NFC_E_ACUTE = "\u00e9"; // single NFC code point
const NFD_E_ACUTE = "e\u0301"; // e + combining acute (NFD)
const BOM = "\uFEFF";

describe("vendored content-normalization-v1 parity with the shared golden corpus (ADR test 7)", () => {
  it("loads the normalization section with vectors", () => {
    expect(corpus.normalization.length).toBeGreaterThan(0);
  });

  it.each(corpus.normalization.map((v) => [v.label, v] as const))(
    "reproduces the recorded normalized text + hash for: %s",
    (_label, v) => {
      const { normalized } = normalizeContent(v.raw, v.version);
      expect(normalized).toBe(v.normalized);
      expect(normalizedContentHash(v.raw, v.version)).toBe(
        v.normalizedContentHash,
      );
    },
  );
});

describe("vendored content-normalization-v1 stability across capture artifacts", () => {
  it("hashes CRLF, lone-CR, BOM, and NFD variants of the same text identically", () => {
    const canonical = `line one\nline two\ncaf${NFC_E_ACUTE}\n`;
    const crlf = `line one\r\nline two\r\ncaf${NFC_E_ACUTE}\r\n`;
    const loneCr = `line one\rline two\rcaf${NFC_E_ACUTE}\r`;
    const bom = `${BOM}line one\nline two\ncaf${NFC_E_ACUTE}\n`;
    const nfd = `line one\nline two\ncaf${NFD_E_ACUTE}\n`;
    const target = normalizedContentHash(canonical);
    expect(normalizedContentHash(crlf)).toBe(target);
    expect(normalizedContentHash(loneCr)).toBe(target);
    expect(normalizedContentHash(bom)).toBe(target);
    expect(normalizedContentHash(nfd)).toBe(target);
  });
});

describe("vendored content-normalization-v1 fail-closed contract", () => {
  it("returns the version it normalized under", () => {
    expect(normalizeContent("x").version).toBe(CONTENT_NORMALIZATION_V1);
  });

  it("strips exactly one leading BOM, never an interior BOM", () => {
    expect(normalizeContent(`${BOM}a${BOM}b`).normalized).toBe(`a${BOM}b`);
    expect(normalizeContent(`${BOM}${BOM}a`).normalized).toBe(`${BOM}a`);
  });

  it("throws on an unknown version rather than silently normalizing", () => {
    expect(() => normalizeContent("x", "content-normalization-v2")).toThrow(
      ContentNormalizationError,
    );
  });

  it("rejects a non-string input", () => {
    expect(() =>
      normalizeContent(undefined as unknown as string),
    ).toThrow(ContentNormalizationError);
  });

  it("agrees with the canonical SHA-256 of the empty string", () => {
    const EMPTY_SHA =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(normalizedContentHash("")).toBe(EMPTY_SHA);
  });
});
