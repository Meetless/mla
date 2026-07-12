/**
 * Loader for the mla CLI's vendored documentation corpus.
 *
 * The corpus is generated once in the root `@meetless/utils` workspace and vendored
 * here byte-for-byte as `src/assets/docs-corpus.json` (+ a bare-hex `.sha256`
 * sidecar), pinned by `gen-docs-corpus --check` so the CLI copy can never drift from
 * Control's compiled-in copy. This module reads that committed JSON at runtime and
 * exposes it to the offline surface (`mla docs`, `mla docs <topic>`, `mla docs search`)
 * and to `mla docs ask` (which sends only `{ question, corpusHash }`).
 *
 * Runtime-asset pattern (mirrors dist/build-info.json): the file is read via
 * `fs.readFileSync(path.join(__dirname, "..", "assets", ...))`. This module compiles
 * to `dist/lib/`, so `..` lands at the dist root and the asset resolves at
 * `dist/assets/docs-corpus.json`; in a ts-node/jest dev run `__dirname` is `src/lib/`
 * and it resolves at `src/assets/docs-corpus.json`. The file is embedded into the
 * single-file pkg binary via `pkg.assets`, so `readFileSync` works from `/snapshot`.
 *
 * `corpusHash` is `sha256` over the RAW file bytes, which by construction equals the
 * committed sidecar and Control's `docsCorpusSha256` (the generator hashes the exact
 * same serialized bytes). It is the compatibility token the CLI sends to Control's
 * corpus-hash gate: same bytes here and there, same hash, no `corpus_mismatch`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** One documentation page (slug/title/frontmatter description). */
export interface DocsDoc {
  slug: string;
  title: string;
  description: string;
}

/**
 * One retrievable passage. Structurally a superset of the vendored search's
 * `DocsSearchable` (passageId/slug/title/headingPath/plain), plus the degraded
 * `markdown` the offline reader prints.
 */
export interface DocsPassage {
  passageId: string;
  slug: string;
  title: string;
  headingPath: string[];
  plain: string;
  markdown: string;
}

/** The full corpus object as serialized by the generator. */
export interface DocsCorpusFile {
  version: string;
  source: string;
  docs: DocsDoc[];
  passages: DocsPassage[];
}

/** The loaded corpus plus its self-computed compatibility hash. */
export interface LoadedDocsCorpus {
  version: string;
  docs: DocsDoc[];
  passages: DocsPassage[];
  /** sha256 of the raw corpus file bytes; equals the committed sidecar. */
  corpusHash: string;
}

/** Resolve the vendored asset in both dev (`src/assets`) and built (`dist/assets`). */
function assetPath(file: string): string {
  return path.join(__dirname, "..", "assets", file);
}

let cached: LoadedDocsCorpus | null = null;

/**
 * Read, parse, and hash the vendored corpus (memoized for the process). Throws if the
 * asset is missing or malformed: a CLI build without its embedded corpus is broken,
 * and the offline surface has nothing to show, so failing loudly beats a silent empty
 * corpus. Callers that must degrade gracefully can wrap this in a try/catch.
 */
export function loadDocsCorpus(): LoadedDocsCorpus {
  if (cached) return cached;
  const raw = fs.readFileSync(assetPath("docs-corpus.json"), "utf8");
  const corpusHash = crypto.createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
  const parsed = JSON.parse(raw) as DocsCorpusFile;
  cached = {
    version: parsed.version,
    docs: parsed.docs,
    passages: parsed.passages,
    corpusHash,
  };
  return cached;
}

/**
 * The committed sha256 sidecar shipped alongside the JSON. Exposed for the vendor-sync
 * spec (asset bytes vs. sidecar vs. self-computed hash must all agree); runtime callers
 * should use `loadDocsCorpus().corpusHash`, which is computed from the bytes actually
 * loaded rather than trusting the sidecar.
 */
export function readDocsCorpusSidecar(): string {
  return fs.readFileSync(assetPath("docs-corpus.sha256"), "utf8").trim();
}
