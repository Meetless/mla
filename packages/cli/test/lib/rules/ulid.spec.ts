import { encodeRandom, encodeTime, ulid, type RandInt32 } from "../../../src/lib/rules/ulid";

// Persistence slice 3: PreToolUse carries no tool_use_id, so R0 mints its own
// attempt_id / evaluation_id locally. A ULID is the right primary key: 26 Crockford
// base32 chars, a 48-bit millisecond timestamp prefix that makes the keys
// lexicographically time-sortable, and 80 bits of randomness so two records minted in
// the same millisecond (the attempt and its observed-arm evaluation) never collide.
// `now` and the random source are injectable so these tests are deterministic and never
// touch Date.now()/crypto in their assertions.

// Crockford base32 excludes I, L, O, U.
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("encodeTime: 48-bit millisecond timestamp as Crockford base32", () => {
  it("encodes a 10-char, Crockford-only string", () => {
    const s = encodeTime(1718700000000, 10);
    expect(s).toHaveLength(10);
    expect(s).toMatch(CROCKFORD);
  });

  it("encodes time 0 as all zeros", () => {
    expect(encodeTime(0, 10)).toBe("0000000000");
  });

  it("is order-preserving: an earlier millisecond sorts before a later one", () => {
    expect(encodeTime(1, 10) < encodeTime(2, 10)).toBe(true);
    expect(encodeTime(1718700000000, 10) < encodeTime(1718700000001, 10)).toBe(true);
  });
});

describe("encodeRandom: Crockford base32 from an injected 0..31 source", () => {
  it("encodes a 16-char, Crockford-only string", () => {
    const s = encodeRandom(16, () => 0);
    expect(s).toHaveLength(16);
    expect(s).toMatch(CROCKFORD);
  });

  it("maps the injected 0..31 integers through the Crockford alphabet", () => {
    // 0 -> '0', 31 -> 'Z' (last alphabet symbol)
    expect(encodeRandom(2, () => 0)).toBe("00");
    expect(encodeRandom(2, () => 31)).toBe("ZZ");
  });
});

describe("ulid: 26-char time-prefixed identifier", () => {
  const zeros: RandInt32 = () => 0;
  const ones: RandInt32 = () => 31;

  it("is exactly 26 Crockford base32 chars", () => {
    const id = ulid(1718700000000, zeros);
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD);
  });

  it("places the time prefix first so two ulids sort by mint time regardless of randomness", () => {
    // Earlier time with maximal randomness must still sort before a later time with
    // minimal randomness: the 10-char time prefix dominates the lexicographic order.
    const earlier = ulid(1718700000000, ones);
    const later = ulid(1718700000001, zeros);
    expect(earlier < later).toBe(true);
  });

  it("mints distinct ids in the same millisecond (80 bits of randomness)", () => {
    let n = 0;
    const counter: RandInt32 = () => n++ % 32;
    const a = ulid(1718700000000, counter);
    const b = ulid(1718700000000, counter);
    expect(a).not.toBe(b);
  });

  it("defaults now and the random source so production callers pass nothing", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(CROCKFORD);
  });
});
