import {
  scanForCredentials,
  scanForSecrets,
  CREDENTIAL_RULE_IDS,
} from "../../src/lib/redactor";

// Pre-upload credential denylist (proposal §4 SECRET-1, §6 Phase 2A/2B).
//
// This is the precision-first blocker that withholds a file from the LIVE
// capture upload. It must catch known credential FORMATS and, critically, must
// NOT fire on high-entropy prose: the generic Shannon heuristic over-blocked
// 99.2% of the real corpus in Phase 0A, so it is excluded from the blocking
// path. These tests pin both halves of that contract.
//
// SECRET-1: never embed a real credential value. The redis_directive fixtures
// use an obviously-fake value.
describe("scanForCredentials (pre-upload credential denylist)", () => {
  it("fires on the Redis requirepass directive (the live-corpus format)", () => {
    expect(scanForCredentials("config: requirepass FAKE_VALUE_xyz")).toEqual([
      "redis_directive",
    ]);
    expect(scanForCredentials("masterauth FAKE")).toEqual(["redis_directive"]);
    expect(scanForCredentials("masteruser FAKE")).toEqual(["redis_directive"]);
  });

  it("fires on provider-token prefixes", () => {
    expect(scanForCredentials("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("k=sk-proj-AbCdEfGhIjKlMnOpQrStUv")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("aws AKIAIOSFODNN7EXAMPLE here")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("xoxb-1234567890-abcdefghij")).toEqual([
      "provider_token",
    ]);
  });

  it("fires on Authorization bearer/basic, cookies, and PEM private keys", () => {
    expect(
      scanForCredentials("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.p.s"),
    ).toEqual(["bearer"]);
    expect(scanForCredentials("Set-Cookie: session=abc123; HttpOnly")).toEqual([
      "cookie",
    ]);
    expect(
      scanForCredentials(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
      ),
    ).toEqual(["pem_key"]);
  });

  it("fires on a credential-named env assignment", () => {
    expect(
      scanForCredentials("export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOp"),
    ).toEqual(expect.arrayContaining(["env_assignment"]));
    expect(scanForCredentials("DATABASE_PASSWORD=hunter2hunter2")).toEqual([
      "env_assignment",
    ]);
  });

  it("does NOT fire on high-entropy prose or a bare base64 blob (entropy heuristic excluded)", () => {
    // A 44-char mixed-class base64 blob: scanForSecrets blocks it via the
    // entropy heuristic; scanForCredentials deliberately does not.
    const blob = "Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345";
    expect(scanForSecrets(`blob: ${blob}`)).toContain("high_entropy_token");
    expect(scanForCredentials(`blob: ${blob}`)).toEqual([]);
  });

  it("does NOT fire on a bare git SHA or content hash", () => {
    expect(
      scanForCredentials("commit a887f06d and digest deadbeefcafebabe00112233"),
    ).toEqual([]);
    expect(
      scanForCredentials(
        "sha256: 9f88098daa3be67454cc4cc0e3e34ee20506affac308839891",
      ),
    ).toEqual([]);
  });

  it("does NOT fire on ordinary durable-memory prose", () => {
    expect(
      scanForCredentials(
        "The control service owns the Decision Diff state machine and outbox.",
      ),
    ).toEqual([]);
  });

  it("returns sorted, de-duplicated rule ids and never the secret text", () => {
    const text =
      "Authorization: Bearer eyJabc.def.ghi and token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX and requirepass FAKE";
    const hits = scanForCredentials(text);
    expect(hits).toEqual(["bearer", "provider_token", "redis_directive"]);
    expect(hits).toEqual([...hits].sort());
    expect(hits.join(" ")).not.toContain("ghp_");
    expect(hits.join(" ")).not.toContain("eyJabc");
    expect(hits.join(" ")).not.toContain("FAKE");
  });

  it("treats empty, null, and undefined as clean", () => {
    expect(scanForCredentials("")).toEqual([]);
    expect(scanForCredentials(null)).toEqual([]);
    expect(scanForCredentials(undefined)).toEqual([]);
  });

  it("every advertised rule id is reachable and entropy is not among them", () => {
    expect([...CREDENTIAL_RULE_IDS].sort()).toEqual([
      "bearer",
      "cookie",
      "env_assignment",
      "pem_key",
      "provider_token",
      "redis_directive",
    ]);
    expect(CREDENTIAL_RULE_IDS).not.toContain("high_entropy_token");
  });
});
