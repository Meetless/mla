// Every row of the real egress registry, driven through the real boundary onto
// a recording socket, and judged on the BYTES that reached the socket.
//
// The other egress specs test the engine and the registry's shape. This one
// tests the only thing a reviewer actually cares about: for each declared rule,
// what comes out the far end. It exists because a registry is a claim, and a
// claim about wire bytes is only worth what a wire test says it is.
//
// The coverage is structural, not curated. The cases are generated FROM
// EGRESS_RULES, so a row added later is exercised the moment it is added, and a
// row using a rule mode nobody wrote an expectation for fails the mode census
// rather than being silently skipped. There is no allowlist to forget to update.
//
// What each mode is held to:
//
//   redact            every "redact" field arrives with the credential gone;
//                     every "preserve" field arrives byte for byte.
//   passthrough       the whole body arrives byte for byte. That is not a
//                     loophole being excused, it is the declaration being
//                     PROVEN: a passthrough row ships whatever it is given, so
//                     its field list has to be structural, and this test is what
//                     makes a content field added to one visible.
//   block             throws before a socket is ever opened.
//   block_on_detect   clean body byte for byte; credential-bearing body refused,
//                     with rule IDS in the diagnostic and never the secret.
//
// The socket is a socket, not a policy seam (see the note in egress/fetch.ts).
// It is substituted here for the same reason a test substitutes a database:
// to read what was written. Nothing about substituting it can change what the
// policy decided, because the policy has already run by the time it is called.

import {
  EgressPolicyError,
  EgressRule,
  EgressService,
} from "../../src/lib/egress/policy";
import { egressFetch } from "../../src/lib/egress/fetch";
import { EGRESS_RULES } from "../../src/lib/egress/rules";

// A provider-prefixed key: caught by the literal denylist, so it is redacted
// under every profile and detected by every block_on_detect scan. Using an
// entropy-only token here would make the test depend on which profile a row
// picked, which is a different property with its own spec.
const SECRET = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";

/** Sentinel that must never be touched by anything: proves preserve is exact. */
const KEEP = "keep/me/exactly-as-written.md";

const ORIGIN: Record<EgressService, string> = {
  control: "https://control.example.test",
  intel: "https://intel.example.test",
  external: "https://external.example.test",
};

/**
 * Build a pathname that the rule's own regex accepts.
 *
 * Deliberately understands only the constructs the registry actually uses:
 * literals, escaped characters, a `[^/]+` id segment, and a `(a|b)` alternation.
 * Anything else THROWS rather than guessing, so a future row written with a
 * construct this cannot model fails loudly here instead of quietly opting out of
 * its own wire test. Every generated path is checked back against the regex
 * below, so the generator cannot drift into producing something that merely
 * looks right.
 */
function samplePath(re: RegExp): string {
  const src = re.source;
  if (!src.startsWith("^") || !src.endsWith("$")) {
    throw new Error(`rule regex is not anchored at both ends: ${re}`);
  }
  const inner = src.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      out += inner[i + 1];
      i += 2;
      continue;
    }
    if (inner.startsWith("[^/]+", i)) {
      out += "sample-id";
      i += "[^/]+".length;
      continue;
    }
    if (inner[i] === "(") {
      const close = inner.indexOf(")", i);
      if (close === -1) throw new Error(`unbalanced group in ${re}`);
      const group = inner.slice(i + 1, close);
      if (!/^[a-z]+(\|[a-z]+)*$/.test(group)) {
        throw new Error(`unsupported group "${group}" in ${re}`);
      }
      out += group.split("|")[0];
      i = close + 1;
      continue;
    }
    if (/[A-Za-z0-9/_-]/.test(inner[i])) {
      out += inner[i];
      i += 1;
      continue;
    }
    throw new Error(`unsupported regex construct "${inner[i]}" in ${re}`);
  }
  return out;
}

interface Recorded {
  url: string;
  method: string;
  body: string;
}

/** A socket that keeps the bytes instead of sending them. */
function recorder() {
  const seen: Recorded[] = [];
  const socket = async (
    url: string,
    init: { method: string; body: string },
  ): Promise<Recorded> => {
    const row = { url, method: init.method, body: init.body };
    seen.push(row);
    return row;
  };
  return { seen, socket };
}

/** Send `body` to the route this rule owns, and hand back what hit the wire. */
async function sendThrough(rule: EgressRule, body: unknown) {
  const { seen, socket } = recorder();
  const url = `${ORIGIN[rule.service]}${samplePath(rule.match)}`;
  await egressFetch<Recorded>(rule.service, url, {
    method: rule.method,
    body,
    socket,
  });
  if (seen.length !== 1) {
    throw new Error(`expected exactly one send, got ${seen.length}`);
  }
  return seen[0];
}

/** Send and expect the boundary to refuse before the socket is opened. */
async function refuseThrough(rule: EgressRule, body: unknown) {
  const { seen, socket } = recorder();
  const url = `${ORIGIN[rule.service]}${samplePath(rule.match)}`;
  let caught: unknown;
  try {
    await egressFetch<Recorded>(rule.service, url, {
      method: rule.method,
      body,
      socket,
    });
  } catch (err) {
    caught = err;
  }
  return { caught, sends: seen.length };
}

const label = (rule: EgressRule) =>
  `${rule.mode} ${rule.service} ${rule.method} ${samplePath(rule.match)}`;

const byMode = (mode: EgressRule["mode"]) =>
  EGRESS_RULES.filter((r) => r.mode === mode).map(
    (r) => [label(r), r] as [string, EgressRule],
  );

describe("the generated route samples are honest", () => {
  it("produces a pathname each rule's own regex accepts", () => {
    for (const rule of EGRESS_RULES) {
      const sample = samplePath(rule.match);
      expect({ rule: rule.note, sample, matches: rule.match.test(sample) }).toEqual(
        { rule: rule.note, sample, matches: true },
      );
    }
  });

  it("covers every rule mode the union can express", () => {
    // If someone adds a fourth mode, this is what tells them the wire tests do
    // not cover it yet. Counting the rows is not enough: it.each over an empty
    // filter passes vacuously and would report a green suite for zero coverage.
    // The union has exactly three modes and all three are in production; there
    // is deliberately no unconditional "block", because a route that must never
    // carry a body simply has no row, and no row means `egress no_rule`.
    const modes = [...new Set(EGRESS_RULES.map((r) => r.mode))].sort();
    expect(modes).toEqual(["block_on_detect", "passthrough", "redact"]);
  });

  // The mode census above pins the SET of modes present, which is blind to the
  // regression that actually matters: ONE row quietly demoted. Downgrade a
  // block_on_detect route to passthrough and the set is unchanged, the row count
  // is unchanged, every generated-body test still passes (a passthrough row is
  // asked to ship what it is given), and the boundary has stopped defending that
  // route. So the mode is pinned per row, in registry order. Reordering the
  // registry is a diff here too; that is intentional, since a rule's position
  // decides which one wins when two could match.
  it("pins the mode of every row, not just the set of modes", () => {
    const actual = EGRESS_RULES.map(
      (r) => `${r.mode} ${r.service} ${r.method} ${r.match.source}`,
    );
    expect(actual).toEqual([
      "redact intel POST ^\\/v1\\/ask$",
      "redact intel POST ^\\/v1\\/ask\\/retrieve$",
      "passthrough control POST ^\\/internal\\/v1\\/auth\\/token\\/refresh$",
      "passthrough control POST ^\\/internal\\/v1\\/auth\\/sessions\\/revoke$",
      "passthrough control POST ^\\/internal\\/v1\\/auth\\/cli-login-grants\\/exchange$",
      "redact control POST ^\\/internal\\/v1\\/analytics\\/events$",
      "redact control POST ^\\/internal\\/v1\\/agent-traces\\/ingest$",
      "redact control POST ^\\/internal\\/v1\\/evidence\\/work-product-capture$",
      "passthrough intel POST ^\\/v1\\/observability\\/turn-recap$",
      "redact control POST ^\\/internal\\/v1\\/bug-reports$",
      "passthrough control POST ^\\/internal\\/v1\\/bug-reports\\/upload-url$",
      "redact control POST ^\\/internal\\/v1\\/docs\\/ask$",
      "redact control POST ^\\/internal\\/v1\\/session-conflicts\\/[^/]+\\/resolve$",
      "redact control POST ^\\/internal\\/v1\\/session-conflicts\\/[^/]+\\/agent-dismiss$",
      "redact control POST ^\\/internal\\/v1\\/analytics\\/enforcement\\/incidents\\/[^/]+\\/adjudicate$",
      "block_on_detect control POST ^\\/internal\\/v1\\/repo-instruction-snapshots$",
      "block_on_detect control POST ^\\/internal\\/v1\\/repo-instruction-snapshots\\/sweep$",
      "block_on_detect intel POST ^\\/internal\\/v1\\/kb\\/withdraw$",
      "block_on_detect intel POST ^\\/internal\\/v1\\/kb\\/add$",
      "passthrough control POST ^\\/internal\\/v1\\/workspaces$",
      "passthrough control POST ^\\/internal\\/v1\\/workspaces\\/(deactivate|reactivate)$",
      "passthrough control POST ^\\/internal\\/v1\\/workspaces\\/members$",
      "passthrough control POST ^\\/internal\\/v1\\/agent-runs\\/by-session\\/[^/]+\\/(finalize|archive)$",
      "passthrough control POST ^\\/internal\\/v1\\/session-steers\\/by-session\\/[^/]+\\/pull$",
      "passthrough control POST ^\\/internal\\/v1\\/session-steers\\/[^/]+\\/injected$",
      "block_on_detect control POST ^\\/internal\\/v1\\/relationship-candidates\\/publish-rules$",
      "redact control POST ^\\/internal\\/v1\\/relationship-candidates\\/[^/]+\\/(accept|reject|confirm|dismiss)$",
      "redact control POST ^\\/internal\\/v1\\/relationship-candidates\\/[^/]+\\/propose-correction$",
      "redact control POST ^\\/internal\\/v1\\/kb\\/retime$",
      "redact intel POST ^\\/internal\\/v1\\/kb\\/retime$",
      "redact intel POST ^\\/internal\\/v1\\/kb\\/(forget|purge)$",
      "block_on_detect intel POST ^\\/internal\\/v1\\/kb\\/reingest$",
      "redact intel POST ^\\/internal\\/v1\\/kb\\/documents\\/[^/]+\\/scope$",
      "passthrough intel POST ^\\/internal\\/v1\\/kb-claims\\/[^/]+\\/verdict$",
      "passthrough intel POST ^\\/internal\\/v1\\/relation-assertions\\/[^/]+\\/verdict$",
      "redact intel POST ^\\/internal\\/v1\\/active-review\\/detect$",
      "passthrough intel POST ^\\/internal\\/v1\\/onboarding\\/marker$",
      "block_on_detect control POST ^\\/internal\\/v1\\/rules$",
      "block_on_detect control POST ^\\/internal\\/v1\\/rules\\/import$",
      "block_on_detect control PATCH ^\\/internal\\/v1\\/rules\\/[^/]+$",
      "passthrough control POST ^\\/internal\\/v1\\/rules\\/[^/]+\\/revoke$",
    ]);
  });

  it("exercises every row below", () => {
    const covered =
      byMode("redact").length +
      byMode("passthrough").length +
      byMode("block_on_detect").length;
    expect(covered).toBe(EGRESS_RULES.length);
  });
});

// Every field a redact row lets through untouched, pinned.
//
// This is the list that decides what the boundary does NOT protect, so it is
// the list most worth making hard to grow. The wire test above proves the
// declaration is honest; this proves nobody widened it. Adding a field here is
// a deliberate, reviewable line in a diff, which is the only real defence
// against the specific regression that started this whole exercise: content
// arriving on an already-approved route under a new, unnoticed key.
//
// Every entry below is an id, a hash, a fixed enum, a count, a boolean, a
// document SELECTOR (a ref, a repo-relative path, a section path: the thing the
// server needs in order to know WHICH document you mean), or a value the
// producer already redacted. If a future entry is none of those, it does not
// belong here.
//
// The row order is the registry's own, and the assertion is order-sensitive, so
// this table also fails when a row changes MODE: a redact row demoted to
// passthrough vanishes from the left side and the lengths stop matching.
const PRESERVED_BY_ROW: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "intel POST ^\\/v1\\/ask$",
    [
      "as_of",
      "filters",
      "language",
      "max_results",
      "min_results",
      "mode",
      "stream",
      "submission_id",
      "surface",
      // The metering actor: a workspace_users id intel stamps onto
      // llm_usage_events.userId. An id, so it belongs on this list by the rule
      // above; and preserved rather than redacted because a mangled id joins to
      // nothing while still LOOKING attributed, which is worse than absent.
      "user_id",
      "workspace_id",
    ],
  ],
  ["intel POST ^\\/v1\\/ask\\/retrieve$", ["limit", "source_context", "workspace_id"]],
  ["control POST ^\\/internal\\/v1\\/analytics\\/events$", ["workspaceId"]],
  [
    "control POST ^\\/internal\\/v1\\/agent-traces\\/ingest$",
    ["client", "traceId", "workspaceId"],
  ],
  [
    "control POST ^\\/internal\\/v1\\/evidence\\/work-product-capture$",
    [
      "captureContractVersion",
      "capturedTurnEnd",
      "capturedTurnStart",
      "injectId",
      "redactedSubstance",
      "status",
      "truncated",
      "workspaceId",
    ],
  ],
  [
    "control POST ^\\/internal\\/v1\\/bug-reports$",
    [
      "mlaVersion",
      "objectKey",
      "platform",
      "redactionSummary",
      "sessionId",
      "traceId",
      "workspaceId",
    ],
  ],
  ["control POST ^\\/internal\\/v1\\/docs\\/ask$", ["corpusHash"]],
  [
    "control POST ^\\/internal\\/v1\\/session-conflicts\\/[^/]+\\/resolve$",
    ["outcome", "workspaceId"],
  ],
  [
    "control POST ^\\/internal\\/v1\\/session-conflicts\\/[^/]+\\/agent-dismiss$",
    ["runtimeHint"],
  ],
  // No workspaceId: the incident id is in the path and the workspace is resolved
  // server-side. The caller sends the verdict enum and an optional note.
  [
    "control POST ^\\/internal\\/v1\\/analytics\\/enforcement\\/incidents\\/[^/]+\\/adjudicate$",
    ["verdict"],
  ],
  [
    "control POST ^\\/internal\\/v1\\/relationship-candidates\\/[^/]+\\/(accept|reject|confirm|dismiss)$",
    ["userId", "workspaceId"],
  ],
  // `correction` is a nested object of enums plus one section path
  // (correctionKind, correctedRelationType, scopeKind, sourceSectionPath): a
  // structured selector, not prose. The prose on this route is `note`, which is
  // redacted.
  [
    "control POST ^\\/internal\\/v1\\/relationship-candidates\\/[^/]+\\/propose-correction$",
    ["correction", "userId", "workspaceId"],
  ],
  [
    "control POST ^\\/internal\\/v1\\/kb\\/retime$",
    ["actor", "anchorType", "effectiveDate", "sourceItemId", "workspaceId"],
  ],
  [
    "intel POST ^\\/internal\\/v1\\/kb\\/retime$",
    ["actor", "anchorType", "effectiveDate", "sourceItemId", "workspaceId"],
  ],
  // `ref` and `relPath` name WHICH document to forget. Redacting either would
  // make the command address nothing.
  [
    "intel POST ^\\/internal\\/v1\\/kb\\/(forget|purge)$",
    ["actor", "ref", "relPath", "workspaceId"],
  ],
  [
    "intel POST ^\\/internal\\/v1\\/kb\\/documents\\/[^/]+\\/scope$",
    ["actorBy", "scope"],
  ],
  [
    "intel POST ^\\/internal\\/v1\\/active-review\\/detect$",
    ["dryRun", "ownerUserId", "workspaceId"],
  ],
];

describe("redact rows: what reaches the wire", () => {
  const rows = byMode("redact");

  it("pins every field a redact row passes through untouched", () => {
    const actual = EGRESS_RULES.filter((r) => r.mode === "redact").map((r) => {
      if (r.mode !== "redact") throw new Error("filtered wrong");
      return [
        `${r.service} ${r.method} ${r.match.source}`,
        Object.entries(r.fields)
          .filter(([, p]) => p === "preserve")
          .map(([k]) => k)
          .sort(),
      ];
    });
    expect(actual).toEqual(
      PRESERVED_BY_ROW.map(([k, v]) => [k, [...v]]),
    );
  });

  it.each(rows)("%s", async (_name, rule) => {
    if (rule.mode !== "redact") throw new Error("filtered wrong");

    // One synthetic body built from the row's OWN field list, so the test can
    // never test a field the row does not declare, nor miss one it does.
    const body: Record<string, string> = {};
    for (const field of Object.keys(rule.fields)) {
      body[field] = `${field} ${SECRET} ${KEEP}`;
    }

    const wire = await sendThrough(rule, body);
    const sent = JSON.parse(wire.body) as Record<string, unknown>;

    // The exact statement, not the comfortable one. "No secret anywhere on the
    // wire" would be FALSE here and it should be: a "preserve" field is passed
    // through byte for byte by declaration, so a credential planted in one
    // arrives. What the boundary promises is narrower and checkable: the fields
    // still carrying it are EXACTLY the ones the row declared preserve. Writing
    // the loose version would have quietly turned this into a test of nothing,
    // since it fails on every row in the registry.
    const stillCarrying = Object.keys(rule.fields)
      .filter((f) => JSON.stringify(sent[f]).includes(SECRET))
      .sort();
    const declaredPreserve = Object.entries(rule.fields)
      .filter(([, p]) => p === "preserve")
      .map(([k]) => k)
      .sort();
    expect(stillCarrying).toEqual(declaredPreserve);

    for (const [field, policy] of Object.entries(rule.fields)) {
      if (policy === "preserve") {
        expect({ field, value: sent[field] }).toEqual({
          field,
          value: body[field],
        });
      } else {
        expect({ field, leaked: String(sent[field]).includes(SECRET) }).toEqual({
          field,
          leaked: false,
        });
      }
    }
  });

  it.each(rows)("%s refuses one unclassified field", async (_name, rule) => {
    if (rule.mode !== "redact") throw new Error("filtered wrong");
    const body: Record<string, string> = { notAFieldAnybodyClassified: SECRET };
    for (const field of Object.keys(rule.fields)) body[field] = "x";

    const { caught, sends } = await refuseThrough(rule, body);
    expect(sends).toBe(0);
    expect(caught).toBeInstanceOf(EgressPolicyError);
    expect((caught as EgressPolicyError).reason).toBe("unknown_field");
    expect((caught as Error).message).toContain("notAFieldAnybodyClassified");
    expect((caught as Error).message).not.toContain(SECRET);
  });
});

describe("passthrough rows: byte for byte, which is the whole declaration", () => {
  const rows = byMode("passthrough");

  it.each(rows)("%s", async (_name, rule) => {
    if (rule.mode !== "passthrough") throw new Error("filtered wrong");

    const body: Record<string, string> = {};
    for (const field of rule.fields) body[field] = `${field} ${KEEP}`;

    const wire = await sendThrough(rule, body);
    expect(JSON.parse(wire.body)).toEqual(body);
    // Byte-exact, not merely deep-equal: key order and encoding are preserved
    // because the boundary serializes the object it was handed.
    expect(wire.body).toBe(JSON.stringify(body));
  });

  it.each(rows)("%s ships what it is given, unredacted", async (_name, rule) => {
    if (rule.mode !== "passthrough") throw new Error("filtered wrong");
    if (rule.fields.length === 0) return; // a bodyless row has nothing to prove

    // The uncomfortable half of the declaration, asserted rather than assumed.
    // A passthrough row does NOT redact. That is only safe while its field list
    // stays structural, so this is the test that makes "someone classified a
    // content field as passthrough" show up as an intentional, reviewed change
    // instead of a quiet one.
    const body: Record<string, string> = {};
    for (const field of rule.fields) body[field] = SECRET;
    const wire = await sendThrough(rule, body);
    expect(wire.body).toContain(SECRET);
  });

  it.each(rows)("%s refuses one unclassified field", async (_name, rule) => {
    if (rule.mode !== "passthrough") throw new Error("filtered wrong");
    const body: Record<string, string> = { notAFieldAnybodyClassified: SECRET };
    for (const field of rule.fields) body[field] = "x";

    const { caught, sends } = await refuseThrough(rule, body);
    expect(sends).toBe(0);
    expect((caught as EgressPolicyError).reason).toBe("unknown_field");
    expect((caught as Error).message).not.toContain(SECRET);
  });
});

describe("block_on_detect rows: clean goes, dirty does not", () => {
  const rows = byMode("block_on_detect");

  it.each(rows)("%s sends a clean body byte for byte", async (_name, rule) => {
    if (rule.mode !== "block_on_detect") throw new Error("filtered wrong");

    const body: Record<string, string> = {};
    for (const field of rule.fields) body[field] = `${field} ${KEEP}`;

    const wire = await sendThrough(rule, body);
    expect(wire.body).toBe(JSON.stringify(body));
    // The point of the mode: a path-shaped token that an entropy bar would eat
    // arrives intact, because a redacted document is a permanently wrong one.
    expect(wire.body).toContain(KEEP);
  });

  it.each(rows)("%s refuses a credential and names the rule, not the secret", async (
    _name,
    rule,
  ) => {
    if (rule.mode !== "block_on_detect") throw new Error("filtered wrong");

    const body: Record<string, string> = {};
    for (const field of rule.fields) body[field] = "clean";
    body[rule.fields[0]] = `preamble ${SECRET} tail`;

    const { caught, sends } = await refuseThrough(rule, body);
    expect(sends).toBe(0);
    expect(caught).toBeInstanceOf(EgressPolicyError);
    expect((caught as EgressPolicyError).reason).toBe("blocked");
    expect((caught as Error).message).toContain("provider_token");
    expect((caught as Error).message).not.toContain(SECRET);
  });
});

describe("fail-closed holds in production mode", () => {
  // Ruling §2: "Unknown routes and unknown fields on classified capture routes
  // must fail closed in ALL environments. No feature flag."
  //
  // The strongest form of that is not a test at all, it is that egress/policy.ts
  // and egress/rules.ts read process.env ZERO times; the first assertion below
  // is what keeps that true. The rest is the belt: run the refusal paths with
  // NODE_ENV=production and with every plausible bypass name set to a truthy
  // value, and watch them refuse anyway.
  const BYPASS_ATTEMPTS = {
    NODE_ENV: "production",
    MLA_EGRESS_DISABLE: "1",
    MLA_SKIP_REDACTION: "1",
    MLA_REDACT_OFF: "true",
    MLA_DEV: "1",
    MLA_DEBUG: "1",
    DISABLE_EGRESS_POLICY: "1",
  };

  let saved: Record<string, string | undefined>;

  beforeAll(() => {
    saved = Object.fromEntries(
      Object.keys(BYPASS_ATTEMPTS).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, BYPASS_ATTEMPTS);
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads no environment variable at all in the policy or the registry", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const file of ["policy.ts", "rules.ts", "fetch.ts"]) {
      const src = readFileSync(
        path.join(__dirname, "..", "..", "src", "lib", "egress", file),
        "utf8",
      );
      const code = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect({ file, envReads: /process\.env/.test(code) }).toEqual({
        file,
        envReads: false,
      });
    }
  });

  it("still refuses an unregistered route", async () => {
    const { seen, socket } = recorder();
    await expect(
      egressFetch<Recorded>("control", "https://c.test/internal/v1/nope", {
        method: "POST",
        body: { anything: SECRET },
        socket,
      }),
    ).rejects.toThrow(/egress no_rule/);
    expect(seen).toEqual([]);
  });

  it("still refuses an unclassified field on a real route", async () => {
    const rule = EGRESS_RULES.find((r) => r.mode === "redact");
    if (!rule) throw new Error("no redact rule in the registry");
    const { caught, sends } = await refuseThrough(rule, {
      surpriseField: SECRET,
    });
    expect(sends).toBe(0);
    expect((caught as EgressPolicyError).reason).toBe("unknown_field");
  });

  it("still refuses a body on a verb that cannot carry one", async () => {
    const { seen, socket } = recorder();
    await expect(
      egressFetch<Recorded>("intel", "https://i.test/v1/ask", {
        method: "GET",
        body: { question: SECRET },
        socket,
      }),
    ).rejects.toThrow(/must not carry a body/);
    expect(seen).toEqual([]);
  });

  it("still redacts on a real route", async () => {
    const rule = EGRESS_RULES.find(
      (r) => r.mode === "redact" && r.service === "intel",
    );
    if (!rule || rule.mode !== "redact") throw new Error("no intel redact rule");
    const redacted = Object.entries(rule.fields)
      .filter(([, p]) => p === "redact")
      .map(([k]) => k);
    expect(redacted.length).toBeGreaterThan(0);
    const body: Record<string, string> = {};
    for (const field of redacted) body[field] = SECRET;
    const wire = await sendThrough(rule, body);
    expect(wire.body).not.toContain(SECRET);
  });
});
