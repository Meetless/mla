import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadDocsCorpus, readDocsCorpusSidecar } from "../../src/lib/docs-corpus";

/**
 * Vendor-parity guard for the CLI's copy of the docs corpus. The corpus is generated
 * once in @meetless/utils and vendored here; `gen-docs-corpus --check` is the
 * cross-boundary byte-identity gate. This spec proves the CLI copy is INTERNALLY
 * consistent and that the runtime loader computes the compatibility hash Control's
 * corpus-hash gate expects: raw bytes -> sha256 -> equals the committed sidecar.
 */
const ASSETS = path.join(__dirname, "..", "..", "src", "assets");

describe("vendored docs corpus", () => {
  it("hashes to its committed sidecar (bare-hex, single trailing newline)", () => {
    const raw = fs.readFileSync(path.join(ASSETS, "docs-corpus.json"), "utf8");
    const expected = fs.readFileSync(path.join(ASSETS, "docs-corpus.sha256"), "utf8");
    // Sidecar is exactly 64 hex chars + one newline (the corpus-sync contract).
    expect(expected).toMatch(/^[0-9a-f]{64}\n$/);
    const actual = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    expect(actual).toBe(expected.trim());
  });

  it("loader computes corpusHash equal to the sidecar", () => {
    const corpus = loadDocsCorpus();
    expect(corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(corpus.corpusHash).toBe(readDocsCorpusSidecar());
  });

  it("loads a non-empty, internally consistent corpus", () => {
    const corpus = loadDocsCorpus();
    expect(corpus.version).toBe("docs-corpus/v1");
    expect(corpus.docs.length).toBeGreaterThan(0);
    expect(corpus.passages.length).toBeGreaterThan(0);
    const slugs = new Set(corpus.docs.map((d) => d.slug));
    for (const p of corpus.passages) {
      expect(slugs.has(p.slug)).toBe(true);
      expect(p.passageId === p.slug || p.passageId.startsWith(p.slug + "#")).toBe(true);
    }
  });

  it("memoizes: repeated loads return the same object", () => {
    expect(loadDocsCorpus()).toBe(loadDocsCorpus());
  });
});
