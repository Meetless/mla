import * as crypto from "node:crypto";
import { loadDocsCorpus, vendoredDocsCorpusSha256 } from "../../src/lib/docs-corpus";
import { DOCS_CORPUS_JSON } from "../../src/lib/docs-corpus.data";

/**
 * Vendor-parity guard for the CLI's copy of the docs corpus. The corpus is generated
 * once in @meetless/utils and vendored here AS CODE (src/lib/docs-corpus.data.ts);
 * `gen-docs-corpus --check` is the cross-boundary byte-identity gate. This spec proves
 * the CLI copy is INTERNALLY consistent and that the runtime loader computes the
 * compatibility hash Control's corpus-hash gate expects: carried bytes -> sha256 ->
 * equals the sha the generator pinned into the very same module.
 */
describe("vendored docs corpus", () => {
  it("carries bytes that hash to its pinned sha (the compatibility token)", () => {
    const pinned = vendoredDocsCorpusSha256();
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    const actual = crypto
      .createHash("sha256")
      .update(Buffer.from(DOCS_CORPUS_JSON, "utf8"))
      .digest("hex");
    expect(actual).toBe(pinned);
  });

  it("carries the canonical serialization verbatim (pretty JSON, one trailing newline)", () => {
    // The generator writes JSON.stringify(corpus, null, 2) + "\n" and hashes exactly
    // those bytes. If this module ever carried a RE-serialized object instead of the
    // literal text, its sha would diverge from Control's and every ask would come back
    // corpus_mismatch. Re-deriving the canonical form here is that guard.
    const parsed = JSON.parse(DOCS_CORPUS_JSON) as unknown;
    expect(JSON.stringify(parsed, null, 2) + "\n").toBe(DOCS_CORPUS_JSON);
  });

  it("loader computes corpusHash equal to the pinned sha", () => {
    const corpus = loadDocsCorpus();
    expect(corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/);
    expect(corpus.corpusHash).toBe(vendoredDocsCorpusSha256());
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
