import { scanForSecrets, SECRET_SCANNER_VERSION } from "../../../src/lib/redactor";

describe("scanForSecrets (block-on-detect)", () => {
  it("returns no rule ids for clean prose", () => {
    expect(scanForSecrets("just a normal sentence about the project state.")).toEqual([]);
  });

  it("catches the Redis requirepass directive the substitution redactor misses", () => {
    // The live corpus secret is a short value; env_assignment (uppercase) and the
    // 32-char entropy gate both miss it, so the directive pattern must catch it.
    const hits = scanForSecrets("redis_url with requirepass O3o7j8zX then more text");
    expect(hits).toContain("redis_directive");
  });

  it("catches masterauth and masteruser directives", () => {
    expect(scanForSecrets("masterauth somesecret")).toContain("redis_directive");
    expect(scanForSecrets("masteruser admin")).toContain("redis_directive");
  });

  it("catches an env-assignment style API key", () => {
    expect(scanForSecrets("ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789")).toContain(
      "env_assignment",
    );
  });

  it("catches a bearer token", () => {
    expect(scanForSecrets("Authorization: Bearer abcDEF123ghiJKL456")).toContain("bearer");
  });

  it("does NOT block a 40-char hex git/content hash (hex exclusion)", () => {
    // The corpus is dense with SHA hashes; treating them as secrets would block
    // nearly every file.
    const sha = "a".repeat(7) + "b".repeat(33); // 40 hex chars
    expect(scanForSecrets(`commit ${sha} landed the fix`)).toEqual([]);
  });

  it("does block a high-entropy mixed-class base64-ish blob", () => {
    const blob = "aGVsbG8Xk9_Q-2za7Bc8dEf4Gh1Jk5Lm6No0Pq3Rs7Tu";
    expect(scanForSecrets(`token=${blob}`)).toContain("high_entropy_token");
  });

  it("never returns the secret text, only rule ids", () => {
    const hits = scanForSecrets("requirepass O3o7j8zX");
    for (const h of hits) expect(h).not.toContain("O3o7j8zX");
  });

  it("exposes a stable scanner version string for ledger policy bumps", () => {
    expect(typeof SECRET_SCANNER_VERSION).toBe("string");
    expect(SECRET_SCANNER_VERSION.length).toBeGreaterThan(0);
  });

  it("returns [] for null/empty input", () => {
    expect(scanForSecrets(null)).toEqual([]);
    expect(scanForSecrets("")).toEqual([]);
    expect(scanForSecrets(undefined)).toEqual([]);
  });
});
