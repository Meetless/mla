import { createHash } from "node:crypto";

/**
 * VENDORED content normalization (`content-normalization-v1`).
 *
 * This is a byte-faithful mirror of the canonical implementation in
 * `packages/utils/src/content-normalization.ts` (monorepo) and its Python twin
 * `intel/app/core/content_normalization.py`. The `mla` CLI is a self-contained
 * pnpm workspace with NO `@meetless/utils` dependency, so the contract is
 * VENDORED here rather than imported. All three copies MUST emit byte-identical
 * normalized text and identical hashes for the same input; the shared golden
 * corpus (`test/fixtures/content-normalization/content-normalization-corpus.json`)
 * plus a committed sha256 sidecar are the cross-repo byte-identity contract, and
 * the CLI parity spec re-derives every corpus hash with THIS module. If you edit
 * the normalization steps here, you are forking the contract: bump the version
 * string in ALL copies and regenerate the corpus, do not silently diverge.
 *
 * Why the CLI needs it: the scan path emits a local `normalizedContentHash` per
 * instruction-file artifact so a governance finding can later be replayed at
 * prompt-assembly time and dropped if the file drifted (ADR
 * `notes/20260717-adr-decision-record-projection-and-reconciliation.md`, §3.3).
 * The server recomputes the same digest from the uploaded normalized content, so
 * the two sides can only agree if this mirror stays byte-identical.
 *
 * V1 NORMALIZATION PROFILE (fixed order, erases trivial capture artifacts only):
 *   1. Strip a single leading UTF-8 BOM (U+FEFF) if present.
 *   2. Normalize line endings: CRLF (\r\n) and lone CR (\r) both become LF (\n).
 *   3. Unicode NFC normalization.
 * V1 deliberately does NOT trim, collapse whitespace, lowercase, or touch a
 * trailing newline: those would lose information or corrupt offset fidelity.
 */

/** The one normalization contract this build implements. */
export const CONTENT_NORMALIZATION_V1 = "content-normalization-v1";

/** Thrown for any input the normalizer refuses (fail-closed). */
export class ContentNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentNormalizationError";
  }
}

const BOM = "﻿";

/** SHA-256 (hex) of the UTF-8 bytes of `text`. Mirrors utils `sha256Hex`. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalize raw text under a named version. Returns the normalized text and the
 * version it was produced under. Throws on an unknown version rather than
 * silently normalizing under an unintended contract.
 */
export function normalizeContent(
  raw: string,
  version: string = CONTENT_NORMALIZATION_V1,
): { version: string; normalized: string } {
  if (version !== CONTENT_NORMALIZATION_V1) {
    throw new ContentNormalizationError(
      `unknown contentNormalizationVersion '${version}'; this build implements only '${CONTENT_NORMALIZATION_V1}'`,
    );
  }
  if (typeof raw !== "string") {
    throw new ContentNormalizationError("content to normalize must be a string");
  }
  let s = raw;
  // 1. Strip a single leading BOM.
  if (s.startsWith(BOM)) {
    s = s.slice(BOM.length);
  }
  // 2. Line endings: CRLF first, then any remaining lone CR, both to LF.
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // 3. Unicode NFC.
  s = s.normalize("NFC");
  return { version, normalized: s };
}

/**
 * SHA-256 (hex) of the content normalized under `version`. This is the artifact
 * revision digest the server dedups on and the prompt-time rehash compares
 * against; the utils + Python mirrors compute the identical hex for the same
 * raw input + version.
 */
export function normalizedContentHash(
  raw: string,
  version: string = CONTENT_NORMALIZATION_V1,
): string {
  return sha256Hex(normalizeContent(raw, version).normalized);
}
