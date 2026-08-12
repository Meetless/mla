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

// --- Phase 4: narrow redis_directive to real arguments -----------------------
// notes/20260805-did-mla-help-...md §12.5b. Two rules do ALL the blocking in this
// corpus: env_assignment and redis_directive. The entropy rule blocks nothing, so
// it is deliberately untouched here.
//
// Measured 2026-08-06 against the live scanner: env_assignment needs NO change.
// Every placeholder shape passes already (sk_test_..., <secret>, [REDACTED],
// YOUR_TOKEN, ${TOKEN}) and every realistic credential blocks, including one
// pasted into a sentence. redis_directive is the one that lacks that guard.
//
// The narrowing is STRUCTURAL only. A value is exempt when it is unmistakably a
// placeholder or a redaction, never because it happens to sit in prose: we cannot
// tell an English word from a password, and fail-closed is the correct default.
describe("redis_directive: true positives keep blocking", () => {
  it("blocks a realistic password", () => {
    expect(scanForSecrets("requirepass Xk9mQ2vLp4Rt7Ns1")).toContain("redis_directive");
  });

  it("blocks a realistic password quoted", () => {
    expect(scanForSecrets(`requirepass "Xk9mQ2vLp4Rt7Ns1"`)).toContain("redis_directive");
  });

  it("blocks a credential pasted into a sentence, because prose is not an exemption", () => {
    expect(scanForSecrets("we set requirepass Xk9mQ2vLp4Rt7Ns1 on the prod box")).toContain("redis_directive");
  });

  it("blocks a short but real-looking value: we cannot prove a word is not a password", () => {
    expect(scanForSecrets("requirepass hunter2")).toContain("redis_directive");
  });

  it("still blocks the sibling directives", () => {
    expect(scanForSecrets("masterauth Xk9mQ2vLp4Rt7Ns1")).toContain("redis_directive");
    expect(scanForSecrets("masteruser Xk9mQ2vLp4Rt7Ns1")).toContain("redis_directive");
  });
});

describe("redis_directive: structural placeholders are not credentials", () => {
  // Each of these currently BLOCKS, which is the false positive being fixed. They
  // are the shapes documentation actually uses when describing the directive.
  it.each([
    ["angle placeholder", "requirepass <secret>"],
    ["angle placeholder, named", "requirepass <password>"],
    ["bracket redaction", "requirepass [REDACTED]"],
    ["env var reference", "requirepass ${REDIS_PASSWORD}"],
    ["shell var reference", "requirepass $REDIS_PASSWORD"],
    ["your-x-here", "requirepass your-password-here"],
    ["YOUR_TOKEN", "requirepass YOUR_PASSWORD"],
    ["ellipsis", "requirepass ..."],
    ["truncated value", "requirepass Xk9m..."],
    ["x-mask", "requirepass xxxxxxxx"],
  ])("does not block a %s", (_label, text) => {
    expect(scanForSecrets(text)).not.toContain("redis_directive");
  });

  it("does not block the directive named with no argument at all", () => {
    expect(scanForSecrets("set requirepass")).not.toContain("redis_directive");
  });

  it("STILL blocks `the requirepass directive.`, and that is the correct trade", () => {
    // Deliberately asserted, because I first wrote the opposite and it was wrong.
    // Here `requirepass` is an adjective and `directive.` is an English word, but
    // nothing structural separates that from `requirepass hunter2`. Telling them
    // apart needs an NLP classifier, which is explicitly out of scope, so this
    // stays a false positive ON PURPOSE. A file blocked by it is now NAMED with
    // its rule (`mla agent-memory status`), so the cost is one visible, diagnosable
    // withhold rather than a silent one.
    expect(scanForSecrets("the requirepass directive.")).toContain("redis_directive");
  });
});
