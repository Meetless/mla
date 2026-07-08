import { randomBytes } from "crypto";

/**
 * A locally-minted ULID, the primary key for R0 interception records.
 *
 * PreToolUse hooks receive no tool_use_id, so the interception path mints its own
 * attempt_id and evaluation_id. A ULID gives a 26-char Crockford base32 identifier: a
 * 48-bit millisecond timestamp encoded as the leading 10 chars (so keys sort
 * lexicographically by mint time, matching created_at order) followed by 80 bits of
 * randomness (16 chars) so the attempt row and its observed-arm evaluation row, minted in
 * the same transaction within one millisecond, never collide.
 *
 * `now` and the random source are parameters so the durable-observation slice and its
 * tests stay deterministic; production callers pass nothing and get Date.now() + a CSPRNG.
 */

// Crockford base32: digits 0-9 then A-Z excluding I, L, O, U (32 symbols).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A source of uniformly-distributed integers in [0, 31]. */
export type RandInt32 = () => number;

// 256 is an exact multiple of 32, so a single random byte modulo 32 is unbiased.
const defaultRand: RandInt32 = () => randomBytes(1)[0] % 32;

/** Encode a non-negative millisecond timestamp as `len` Crockford base32 chars (big-endian). */
export function encodeTime(ms: number, len = 10): string {
  let value = ms;
  let out = "";
  for (let i = 0; i < len; i++) {
    const mod = value % 32;
    out = CROCKFORD[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

/** Encode `len` Crockford base32 chars drawn from a 0..31 integer source. */
export function encodeRandom(len = 16, rand: RandInt32 = defaultRand): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CROCKFORD[rand() % 32];
  }
  return out;
}

/** Mint a 26-char ULID: a 10-char time prefix followed by 16 chars of randomness. */
export function ulid(now: number = Date.now(), rand: RandInt32 = defaultRand): string {
  return encodeTime(now, 10) + encodeRandom(16, rand);
}
