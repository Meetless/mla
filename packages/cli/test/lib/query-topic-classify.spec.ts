// Phase 5A: classify a turn's prompt into the EXISTING closed topic enum, inside
// the hook, where the prompt already is.
//
// notes/20260805-did-mla-help-...md §12.5h. `query_topic_category` shipped as a
// closed enum on the coverage-gap payload, was rendered by `mla stats`, and was
// PERMANENTLY `unknown`, because nobody ever passed `--topic-category`. It is the
// fifth structurally-complete-but-inert instrument found in this workstream, and
// the one dimension that makes section 4 ("the roadmap") actionable.
//
// The prompt is classified here and NOWHERE else. Only the resulting enum value
// leaves this function. INV-POSTHOG-PII-1 bars the prompt from the analytics
// plane, and A2 established that exposing query text would mean building a
// prompt-capture path; this is the compliant alternative, so the discipline that
// keeps it compliant is asserted below, not assumed.
import { spawnSync } from "child_process";
import { join } from "path";

const HOOKS = join(__dirname, "../../src/hooks-template");

function classify(prompt: string): string {
  // Pass the prompt on argv of a SUBSHELL we control, exactly as the hook does
  // internally (the hook holds it in $PROMPT_HUMAN already). What matters for the
  // privacy contract is what leaves the function, which is asserted separately.
  const script = `source "${HOOKS}/common.sh"; classify_query_topic "$1"`;
  const r = spawnSync("bash", ["-c", script, "_", prompt], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

// The enum is CLOSED and owned by src/lib/analytics/envelope.ts. The classifier
// may never widen it; a new value here would be silently coerced to `unknown`
// downstream by coerceTopicCategory, so a widening would be invisible.
const ENUM = [
  "architecture",
  "testing",
  "deployment",
  "product_decision",
  "customer_context",
  "security",
  "data_model",
  "api_contract",
  "migration",
  "process",
  "unknown",
];

describe("classify_query_topic", () => {
  it("maps representative prompts onto existing enum values", () => {
    expect(classify("how does the retrieval pipeline layer its stages?")).toBe("architecture");
    expect(classify("the jest spec is failing, fix the assertion")).toBe("testing");
    expect(classify("promote the release to prod on cloud run")).toBe("deployment");
    expect(classify("rotate the leaked api credential and check the acl")).toBe("security");
    expect(classify("add a column to the prisma schema for the claim table")).toBe("data_model");
    expect(classify("what does the POST endpoint return in its response body?")).toBe("api_contract");
    expect(classify("write a backfill migration for the existing rows")).toBe("migration");
    expect(classify("what is our convention for review before merging?")).toBe("process");
    expect(classify("which pilot customer churned last week?")).toBe("customer_context");
    expect(classify("should we descope the wedge for this roadmap decision?")).toBe("product_decision");
  });

  it("never emits a value outside the closed enum", () => {
    for (const p of [
      "hello",
      "架构是什么",
      "",
      "!!!",
      "deploy the schema migration test endpoint decision", // deliberately ambiguous
    ]) {
      expect(ENUM).toContain(classify(p));
    }
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classify("hello")).toBe("unknown");
    expect(classify("")).toBe("unknown");
    expect(classify("do the thing we discussed")).toBe("unknown");
  });

  it("emits ONLY the enum token: no prompt text, no fragment of it, ever", () => {
    // The load-bearing privacy assertion. If the classifier ever echoed its input
    // (a stray `set -x`, a debug printf, an unquoted expansion), this catches it,
    // because the enum tokens share no substring with these prompts.
    const secretish = "rotate STRIPE_SECRET_KEY=sk_live_51H8xQ2abcdefgHIJKLmnop for acme corp";
    const out = classify(secretish);
    expect(ENUM).toContain(out);
    expect(out).not.toContain("sk_live");
    expect(out).not.toContain("STRIPE");
    expect(out).not.toContain("acme");
    expect(out.length).toBeLessThanOrEqual("customer_context".length);
  });

  it("never fails: a hostile prompt still yields a usable value and exit 0", () => {
    // Classification must NEVER block injection. Shell metacharacters, newlines,
    // and a very long prompt all have to come back clean.
    const hostile = `$(rm -rf /) \`whoami\` ; echo pwned | tee /tmp/x\n\n${"A".repeat(20000)}`;
    const script = `source "${HOOKS}/common.sh"; classify_query_topic "$1"; echo "exit=$?"`;
    const r = spawnSync("bash", ["-c", script, "_", hostile], { encoding: "utf8" });
    expect(r.stdout).toContain("exit=0");
    expect(r.stdout).not.toContain("pwned");
    const value = (r.stdout || "").split("\n")[0].trim();
    expect(ENUM).toContain(value);
  });

  it("is case insensitive, because operators do not write in lowercase", () => {
    expect(classify("Fix The Failing JEST Spec")).toBe("testing");
    expect(classify("ROTATE THE CREDENTIAL")).toBe("security");
  });
});
