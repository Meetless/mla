import { createHash } from "crypto";

/**
 * Canonical JSON (RFC 8785 JSON Canonicalization Scheme) + SHA-256, vendored into
 * the CLI for the CE0 RequirementSubject fingerprint.
 *
 * Why vendored, not imported: the CLI does not depend on @meetless/utils. This is a
 * byte-faithful copy of packages/utils/src/canonical-json.ts. The forcing function's
 * cross-language contract (proposal §1.6) requires the UserPromptSubmit hook to emit
 * byte-identical subject fingerprints to the utils side, so the canonical encoding
 * MUST match digit-for-digit; the golden corpus drift guard pins it.
 *
 * RFC 8785 rules implemented here:
 *  - objects: keys NFC-normalized then sorted by their UTF-16 code-unit sequence, no
 *    whitespace, `"key":value` joined by `,` inside `{}`.
 *  - arrays: element order preserved, no whitespace, joined by `,` inside `[]`.
 *  - strings: NFC-normalized then escaped exactly as ECMAScript JSON.stringify escapes
 *    a string (RFC 8785 defers to that escaping).
 *  - booleans / null: `true` / `false` / `null`.
 *
 * V1 NUMBER NARROWING: the spec says "numbers in one canonical decimal form", but the
 * cross-language-fragile part is shortest-round-trip serialization of IEEE-754
 * doubles. Every CE0 fingerprint payload contains ZERO floats (only strings + small
 * non-negative ordinals), so V1 accepts ONLY safe integers and FAILS LOUDLY on any
 * non-integer or out-of-safe-range number. Fail-closed: it rejects, never rounds.
 */

/** A value the canonicalizer accepts. `undefined` object properties are treated as
 * absent (omitted), matching JSON.stringify; `null` is emitted. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;

export interface CanonicalObject {
  readonly [key: string]: CanonicalValue | undefined;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/** Serialize a single number per the V1 safe-integer profile (see file header). */
function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(
      `non-finite number ${String(n)} cannot be canonically encoded`,
    );
  }
  if (!Number.isInteger(n)) {
    throw new CanonicalJsonError(
      `non-integer number ${n} rejected by the V1 safe-integer profile; ` +
        `floats are out of scope for fingerprint payloads (see canonical-json.ts header)`,
    );
  }
  if (Math.abs(n) > MAX_SAFE) {
    throw new CanonicalJsonError(
      `integer ${n} exceeds Number.MAX_SAFE_INTEGER and cannot be encoded losslessly`,
    );
  }
  // String(-0) === "0", String(42) === "42": exactly the RFC 8785 integer form.
  return String(n);
}

/** Serialize a string: NFC normalize, then escape exactly as JSON.stringify. */
function encodeString(s: string): string {
  return JSON.stringify(s.normalize("NFC"));
}

function encodeValue(value: CanonicalValue | undefined): string {
  if (value === undefined) {
    throw new CanonicalJsonError(
      "undefined is not a canonical value (use null, or omit the object key)",
    );
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value);
    case "string":
      return encodeString(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(
        `unsupported value type '${typeof value}' in canonical payload`,
      );
  }
  if (Array.isArray(value)) {
    return `[${value.map((el) => encodeValue(el)).join(",")}]`;
  }
  return encodeObject(value as CanonicalObject);
}

function encodeObject(obj: CanonicalObject): string {
  // NFC-normalize keys first so ordering is over the normalized form, then sort by
  // UTF-16 code units. JS default string `<` compares by UTF-16 code unit, which is
  // exactly RFC 8785's key order.
  const entries: Array<[string, CanonicalValue]> = [];
  const seen = new Map<string, string>(); // normalizedKey -> originalKey
  for (const rawKey of Object.keys(obj)) {
    const v = obj[rawKey];
    if (v === undefined) continue; // absent optional: omit, matches JSON.stringify
    const key = rawKey.normalize("NFC");
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new CanonicalJsonError(
        `object keys '${prior}' and '${rawKey}' collide after NFC normalization`,
      );
    }
    seen.set(key, rawKey);
    entries.push([key, v]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${encodeString(k)}:${encodeValue(v)}`)
    .join(",");
  return `{${body}}`;
}

/** Thrown for any input the canonical encoder refuses (fail-closed). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/**
 * Encode a value to its RFC 8785 canonical JSON string. The returned string, UTF-8
 * encoded, is the exact byte sequence that is hashed.
 */
export function canonicalize(value: CanonicalValue): string {
  return encodeValue(value);
}

/** SHA-256 (hex, lowercase, 64 chars) over the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical digest: `sha256Hex(canonicalize(value))`. */
export function canonicalDigest(value: CanonicalValue): string {
  return sha256Hex(canonicalize(value));
}
