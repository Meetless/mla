/**
 * Loader for the mla CLI's vendored documentation corpus.
 *
 * The corpus is generated once in the root `@meetless/utils` workspace and vendored
 * here AS CODE, in `docs-corpus.data.ts` (a generated module, byte-pinned by
 * `gen-docs-corpus --check`, so the CLI copy can never drift from Control's
 * compiled-in copy). This module parses it and exposes it to the offline surface
 * (`mla docs`, `mla docs <topic>`, `mla docs search`) and to `mla docs ask` (which
 * sends only `{ question, corpusHash }`).
 *
 * Compiled-in, never an `fs` read (proposal §9). The corpus rides in a `.ts` module,
 * so plain `tsc` emits it to `dist/lib/docs-corpus.data.js`, `files: ["dist"]` puts it
 * in the npm tarball, and `pkg.scripts` (`dist/**\/*.js`) sweeps it into every native
 * binary. There is no asset to copy, no `pkg.assets` glob to keep in sync, and no
 * `/snapshot` read to get wrong: a build that lost its corpus would fail to compile
 * instead of shipping and exiting 1 in a user's terminal.
 *
 * `corpusHash` is `sha256` over the canonical corpus bytes, which the data module
 * carries verbatim as a string literal. It therefore equals, by construction, the sha
 * the generator computed and Control's `docsCorpusSha256`. It is the compatibility
 * token the CLI sends to Control's corpus-hash gate: same bytes here and there, same
 * hash, no `corpus_mismatch`.
 */
import * as crypto from "node:crypto";
import { DOCS_CORPUS_JSON, DOCS_CORPUS_SHA256 } from "./docs-corpus.data";

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
  /** sha256 of the canonical corpus bytes; equals the generator's pinned sha. */
  corpusHash: string;
}

let cached: LoadedDocsCorpus | null = null;

/**
 * Parse and hash the compiled-in corpus (memoized for the process). Throws if the
 * module's payload is malformed, which can only mean a corrupted build: the offline
 * surface would have nothing to show, so failing loudly beats a silent empty corpus.
 * Callers that must degrade gracefully can wrap this in a try/catch.
 */
export function loadDocsCorpus(): LoadedDocsCorpus {
  if (cached) return cached;
  const raw = DOCS_CORPUS_JSON;
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
 * The sha the generator pinned into the data module. Exposed for the vendor-sync spec
 * (the pinned sha and the hash of the bytes actually carried must agree, so a hand-edit
 * of either half reddens); runtime callers should use `loadDocsCorpus().corpusHash`,
 * which is computed from the bytes actually loaded rather than trusting the pin.
 */
export function vendoredDocsCorpusSha256(): string {
  return DOCS_CORPUS_SHA256;
}
