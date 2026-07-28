// Who is allowed to put bytes on the network, and who owns the /v1/ask body.
//
// The registry in src/lib/egress/rules.ts can only govern requests that pass
// THROUGH it. This file guards the other half of that sentence: it reads the
// shipped source and fails when a module reaches for an outbound primitive
// without being one of the transports we reviewed.
//
// It is deliberately a source scan and not a runtime hook. A runtime hook only
// sees the paths a test happens to execute, so a new `fetch(` in a rarely-run
// command would sail past it. It is also not static ROUTE enumeration (ruled
// out in §6): it enumerates CALLERS, a closed set that only changes when
// somebody adds a transport, which is exactly the moment a human should look.
//
// Every allowance carries the reason it was granted, and the reason is asserted,
// not just written down. An approval with no enforced reason is the failure mode
// this file exists to prevent.

import * as fs from "fs";
import * as path from "path";

import type { CliConfig } from "../../src/lib/config";
import { makeIntelAskFromCli } from "../../src/lib/mcp-fetchers";

const SRC = path.resolve(__dirname, "..", "..", "src");
const ASK_CORE = path.resolve(__dirname, "..", "..", "..", "ask-core");

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const read = (p: string) => fs.readFileSync(p, "utf8");

/**
 * Drop TS comments. Route literals live in strings, so strings SURVIVE here.
 *
 * This matters more than it looks: this codebase comments heavily, and "fetch"
 * and "/v1/ask" appear in prose far more often than in code. Without this the
 * scan is all noise, and the natural response to a noisy guard is to loosen it
 * and then delete it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Drop string, template AND regex literals. For identifier scans only.
 *
 * Regex literals earn their line here: commands/ask.ts classifies a network
 * failure with /ECONNREFUSED|fetch failed|ENOTFOUND/i, and a scan that counted
 * that as an egress would report a file that never touches a socket. A guard
 * that cries wolf once gets an exception added, and the exception is what the
 * next real offender hides behind.
 *
 * The regex sweep is deliberately conservative: it only fires where a `/` can
 * legally START an expression, so `(a + b) / 2` is never mistaken for one.
 */
function stripLiterals(src: string): string {
  return stripComments(src)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(
      /([=(,:[!&|?+;]\s*|^\s*|\breturn\s+)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/gm,
      "$1/RE/",
    );
}

/** Non-comment lines of a shell script. */
function shellCode(src: string): string[] {
  return src.split("\n").filter((l) => /^\s*[^#\s]/.test(l));
}

/**
 * Does this module name the global `fetch` at a VALUE position?
 *
 * Three shapes are not that, and all three occur in the tree:
 *   `typeof fetch`  a type annotation (commands/bug.ts, commands/ask.ts)
 *   `fetch:`        an object property that happens to be named fetch
 *                   (commands/internal-active-review.ts)
 *   `x.fetch(`      a method on something else (facts.fetch(...))
 *
 * A bare reference counts even without a call: `deps.fetchImpl ?? fetch` hands
 * the socket to somebody else and is exactly as much an egress as calling it.
 * An earlier draft of this file matched `fetch\s*\(` only and MISSED that line
 * in commands/bug.ts, which is why the rule is written this way.
 */
function namesGlobalFetch(src: string): boolean {
  const c = stripLiterals(src);
  if (/\bglobalThis\s*\.\s*fetch\b/.test(c)) return true;
  const re = /(^|[^A-Za-z0-9_.$])fetch(?![A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    const start = m.index + m[1].length;
    if (/\btypeof\s+$/.test(c.slice(Math.max(0, start - 12), start))) continue;
    if (/^\s*:/.test(c.slice(start + 5, start + 8))) continue;
    return true;
  }
  return false;
}

/**
 * How many times does this module CALL an outbound primitive?
 *
 * Counts calls through the global `fetch` and through a local binding of it
 * (`const fetchImpl = deps.fetchImpl ?? fetch`), which is the same socket with
 * one more name. A pure function of source text on purpose: the exception pin
 * below mutates a copy of the real file and re-runs this, so "adding a second
 * call fails the test" is proved rather than asserted.
 */
function countOutboundCalls(src: string): number {
  const c = stripLiterals(src);
  return [
    ...c.matchAll(/(^|[^A-Za-z0-9_.$])(fetch|fetchImpl)\s*\(/g),
  ].length;
}

describe("outbound network primitives are owned", () => {
  // The full set of production modules allowed to touch the socket directly.
  // Anything else routes through lib/egress/fetch.ts, where the registry
  // classifies the body. `kind` is load-bearing, not a label: the tests below
  // pin exactly one boundary and exactly one body-sending exception, so a
  // second one cannot be added by writing a new sentence in `why`.
  //
  //   boundary          may hand a CLASSIFIED body to the socket.
  //   bodyless-get      carries no body, so there is nothing to classify.
  //   signed-binary-put the one exception: a binary blob to a pre-signed URL.
  const APPROVED: Record<
    string,
    { kind: "boundary" | "bodyless-get" | "signed-binary-put"; why: string }
  > = {
    "lib/egress/fetch.ts": {
      kind: "boundary",
      why: "THE boundary: the one module that may hand a classified body to the socket",
    },
    "commands/doctor.ts": {
      kind: "bodyless-get",
      why: "health probes (intel /health, control /internal/v1/kb/health)",
    },
    "lib/update-notifier.ts": {
      kind: "bodyless-get",
      why: "the published VERSION file",
    },
    "lib/upgrade-apply.ts": {
      kind: "bodyless-get",
      why: "the signed release manifest",
    },
    "commands/bug.ts": {
      kind: "signed-binary-put",
      why: "PUT of an already-redacted diagnostic bundle to a signed GCS URL, behind an interactive confirm",
    },
  };

  it("lets only reviewed modules name the global fetch", () => {
    const offenders = walk(SRC, [".ts"])
      .filter((p) => namesGlobalFetch(read(p)))
      .map(rel)
      .filter((r) => !(r in APPROVED))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("keeps every approval live", () => {
    // An approval for a file that no longer touches the socket is dead weight
    // that makes the next reader trust the list less.
    const stale = Object.keys(APPROVED)
      .filter((f) => !namesGlobalFetch(read(path.join(SRC, f))))
      .sort();
    expect(stale).toEqual([]);
  });

  it("keeps exactly one boundary and exactly one body-sending exception", () => {
    // The architectural claim, stated as data: one classified HTTP egress
    // boundary, plus one statically pinned signed-binary-upload exception. The
    // rest carry no body at all. Widening this list is a conspicuous diff.
    const byKind = (k: string) =>
      Object.entries(APPROVED)
        .filter(([, v]) => v.kind === k)
        .map(([f]) => f)
        .sort();
    expect(byKind("boundary")).toEqual(["lib/egress/fetch.ts"]);
    expect(byKind("signed-binary-put")).toEqual(["commands/bug.ts"]);
    expect(byKind("bodyless-get")).toEqual([
      "commands/doctor.ts",
      "lib/update-notifier.ts",
      "lib/upgrade-apply.ts",
    ]);
  });

  it("lets no module import a second HTTP client", () => {
    // axios / undici / got / node-fetch, or a raw node:http client. Each is an
    // outbound primitive the egress boundary knows nothing about, so the answer
    // is not "review it", it is "there is already a transport".
    const offenders = walk(SRC, [".ts"])
      .filter((p) => {
        const c = stripComments(read(p));
        if (/(from|require\()\s*["'](axios|undici|got|node-fetch)["']/.test(c)) {
          return true;
        }
        // node:http is legitimate INBOUND (the loopback PKCE server in
        // lib/login.ts), so only an outbound client call counts.
        return /\bhttps?\s*\.\s*(request|get)\s*\(/.test(c);
      })
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("keeps the bodyless approvals bodyless", () => {
    // The GET exemption exists because a bodyless request has nothing for the
    // policy to classify. This is what stops one growing a body later: an
    // approved file that starts sending one is an unclassified egress wearing
    // an approval that was granted for something else.
    const offenders: string[] = [];
    for (const [file, approval] of Object.entries(APPROVED)) {
      if (approval.kind !== "bodyless-get") continue;
      const c = stripComments(read(path.join(SRC, file)));
      for (const m of c.matchAll(/(^|[^A-Za-z0-9_.$])fetch\s*\(/g)) {
        const init = c.slice(m.index, m.index + 400);
        if (/\bbody\s*:/.test(init)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the bug bundle redacted before it leaves the machine", () => {
    // commands/bug.ts is the one approval that DOES send a body, so its reason
    // has to hold up. The zip it PUTs is built by lib/diagnostic-bundle.ts,
    // which is allowlist-first and runs the parity-locked credential scanner
    // over what survives. Assert the wiring, not the prose.
    const bug = stripComments(read(path.join(SRC, "commands", "bug.ts")));
    expect(bug).toMatch(/body:\s*built\.zip/);
    const bundle = read(path.join(SRC, "lib", "diagnostic-bundle.ts"));
    expect(bundle).toMatch(/from\s+["']\.\/redactor["']/);
    expect(stripComments(bundle)).toMatch(/scanForCredentials/);
  });

  // The signed-binary-upload exception, pinned at the CALL, not at the file.
  //
  // "commands/bug.ts is approved" is a file-level grant, and a file-level grant
  // is exactly the kind of permission that quietly widens: the next person with
  // something to upload finds an already-approved module and adds a second
  // call. These four tests make the exception mechanically exceptional. It is
  // ONE call, it is a PUT, its body is a Buffer the bundle builder produced,
  // and its headers are two frozen literals with no caller input anywhere.
  describe("the signed GCS upload exception is pinned to one call", () => {
    const BUG = path.join(SRC, "commands", "bug.ts");

    /** The balanced `{...}` object literal starting at or after `from`. */
    function objectAt(c: string, from: number): string {
      const open = c.indexOf("{", from);
      expect(open).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = open; i < c.length; i++) {
        if (c[i] === "{") depth++;
        else if (c[i] === "}" && --depth === 0) return c.slice(open, i + 1);
      }
      throw new Error("unterminated object literal");
    }

    /** The init object literal of the single outbound call, comments stripped. */
    function callInit(src: string): string {
      const c = stripComments(src);
      const at = c.search(/(^|[^A-Za-z0-9_.$])fetchImpl\s*\(/m);
      expect(at).toBeGreaterThan(-1);
      return objectAt(c, at);
    }

    /** Keys at depth 1 of an object literal. Indentation-independent. */
    function topKeys(obj: string): string[] {
      const out: string[] = [];
      let depth = 0;
      for (let i = 0; i < obj.length; i++) {
        const ch = obj[i];
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
        else if (depth === 1) {
          const m = /^["']?([A-Za-z][A-Za-z0-9_-]*)["']?\s*:/.exec(obj.slice(i));
          if (m && /[\s{,]/.test(obj[i - 1] ?? "")) {
            out.push(m[1]);
            i += m[0].length - 1;
          }
        }
      }
      return out.sort();
    }

    it("contains exactly one direct outbound call", () => {
      expect(countOutboundCalls(read(BUG))).toBe(1);
    });

    it("fails if a second direct call is added", () => {
      // The mutation that this pin exists to catch, run against the real file.
      // Without this, `toBe(1)` could be passing because the counter is broken.
      const mutated =
        read(BUG) +
        '\nasync function leak(u: string, t: string) { await fetchImpl(u, { method: "POST", body: JSON.stringify({ t }) }); }\n';
      expect(countOutboundCalls(mutated)).toBe(2);
    });

    it("binds the socket exactly once, from deps or the global", () => {
      // One binding, one call. A second `= fetch` would be a second socket
      // wearing this file's single approval.
      const c = stripLiterals(read(BUG));
      const bindings = [
        ...c.matchAll(/=\s*[^;\n]*?(^|[^A-Za-z0-9_.$])fetch(?![A-Za-z0-9_(])/gm),
      ];
      expect(bindings.length).toBe(1);
      expect(stripComments(read(BUG))).toMatch(
        /const fetchImpl = deps\.fetchImpl \?\? fetch;/,
      );
    });

    it("sends a PUT of the built Buffer, never JSON or prose", () => {
      const init = callInit(read(BUG));
      expect(init).toMatch(/method:\s*"PUT"/);
      // The body is the zip the bundle builder returned, by identity. Not a
      // string, not a JSON.stringify, not a stream of captured text: the type
      // of that field is what forecloses those, so assert the type too.
      expect(init).toMatch(/body:\s*built\.zip\s*,/);
      expect(init).not.toMatch(/JSON\.stringify/);
      expect(stripComments(read(path.join(SRC, "lib", "diagnostic-bundle.ts")))).
        toMatch(/\bzip:\s*Buffer;/);
      // Nothing else may ride along: method, body, headers, and no more.
      expect(topKeys(init)).toEqual(["body", "headers", "method"]);
    });

    it("sends two frozen headers with no caller input", () => {
      const init = callInit(read(BUG));
      const headers = objectAt(init, init.indexOf("headers:"));
      // Exactly the two the v4 signature was minted over. No spread, no
      // template, no variable: a caller-supplied header name or value is how a
      // binary upload turns into an arbitrary request.
      expect(headers.replace(/\s+/g, " ").replace(/, \}$/, " }")).toBe(
        '{ "Content-Type": "application/zip", "x-goog-if-generation-match": "0" }',
      );
      expect(headers).not.toMatch(/\.\.\./);
      expect(headers).not.toMatch(/`/);
      expect(headers).not.toMatch(/application\/json/);
    });

    it("rejects the widenings this exception exists to forbid", () => {
      // The two assertions above read the real file, so they can only prove
      // that TODAY's call is clean. These run the SAME predicates over mutated
      // copies, which is what proves they would go red rather than quietly
      // matching something looser. Copies only: the real file is untouched.
      const src = read(BUG);
      const mutate = (from: string, to: string) => {
        expect(src).toContain(from);
        return src.replace(from, to);
      };

      // A caller-supplied header turns a signed binary PUT into an arbitrary
      // request wearing this file's approval.
      const withCallerHeader = callInit(
        mutate('"x-goog-if-generation-match": "0",', "...deps.headers,"),
      );
      const h = objectAt(withCallerHeader, withCallerHeader.indexOf("headers:"));
      expect(h).toMatch(/\.\.\./);

      // A JSON body is captured prose by another name.
      const asJson = callInit(
        mutate("body: built.zip,", "body: JSON.stringify(built.manifest),"),
      );
      expect(asJson).toMatch(/JSON\.stringify/);
      expect(asJson).not.toMatch(/body:\s*built\.zip\s*,/);

      // A fourth init key (a stream, a signal, a duplex upgrade) is a shape
      // this exception was never granted for.
      const extraKey = callInit(mutate("body: built.zip,", "body: built.zip,\n      duplex: \"half\","));
      expect(topKeys(extraKey)).toEqual([
        "body",
        "duplex",
        "headers",
        "method",
      ]);
    });
  });

  it("keeps shell curl to the two hook scripts that own their boundary", () => {
    // Ruling §6 gives bash the event-spool boundary. These are the only shipped
    // scripts that actually curl (the rest only mention it in comments), and
    // both ship captured content, so both have to redact first.
    const curling = walk(path.join(SRC, "hooks-template"), [".sh"])
      .filter((p) => shellCode(read(p)).some((l) => /\bcurl\s/.test(l)))
      .map((p) => path.basename(p))
      .sort();
    expect(curling).toEqual(["flush.sh", "user-prompt-submit.sh"]);
  });

  it("makes each curling script redact before it sends", () => {
    const hooks = path.join(SRC, "hooks-template");
    // The spool flush pipes the whole batch through the CLI redactor, and
    // refuses to send when that pass fails rather than falling back to raw.
    const flush = read(path.join(hooks, "flush.sh"));
    expect(flush).toMatch(/_internal\s+redact-events/);
    expect(flush).toMatch(/raw bodies NOT sent/);
    // The Layer-2 enrichment call redacts the question before it builds the
    // /v1/ask body, so truncation happens to already-redacted text.
    const ups = read(path.join(hooks, "user-prompt-submit.sh"));
    expect(ups).toMatch(/_internal\s+redact-capture/);
  });

  it("lets no embedded shell script POST a body", () => {
    // A shell script inside a template literal is invisible to the identifier
    // scan above. Only one exists (connectors/claude-code/plugin-artifact.ts,
    // which curls the public installer during MCP cold boot), and it is a
    // bodyless download. This keeps it that way, and catches the next one.
    const offenders = walk(SRC, [".ts"])
      .filter((p) =>
        /\b(curl|wget)\b[^\n]{0,200}?(-X\s*(POST|PUT|PATCH)|--data|-d\s)/.test(
          read(p),
        ),
      )
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });
});

describe("/v1/ask bodies are parity-locked across both builders", () => {
  // The invariant is NOT "one place builds the body". There are two builders,
  // because the TRANSPORTS genuinely differ and jest provably cannot load
  // ask-core's ESM to share one function: requiring
  // @meetless/ask-core/ask_modes.js under this config dies on
  // `import { randomUUID } from "node:crypto"`, and the only fix is a
  // package-wide transform change across 432 suites. That was measured, not
  // assumed. Collapsing CommonJS and ESM for architectural symmetry would make
  // the code less testable for no security gain.
  //
  // What actually has to hold, and what this file enforces:
  //   - Both builders redact, each with its own tests (here, and
  //     packages/ask-core/ask_modes.test.js).
  //   - Their behavior is parity-locked: both are measured byte for byte
  //     against ONE checked-in fixture, so a field added to one and forgotten
  //     in the other is a red test in two suites rather than a silent
  //     divergence on the wire. Same shape as the redactor's four-plane lock.
  //   - The shared wire boundary re-applies the registered /v1/ask policy to
  //     the CLI-transport body (registry row 1), with the same parity-locked
  //     redactor at the same `retrieval` bar, idempotently.
  //   - No third builder and no direct sender exists: the set of modules that
  //     name /v1/ask is pinned below, in BOTH packages.
  const FIXTURE = JSON.parse(
    read(path.join(ASK_CORE, "ask_payload_parity.json")),
  ) as { input: Record<string, unknown>; wire: string };

  it("posts the parity fixture byte for byte from the CLI transport", async () => {
    let sent: string | null = null;
    const intelPostFn = async (_c: CliConfig, p: string, b: unknown) => {
      expect(p).toBe("/v1/ask");
      sent = JSON.stringify(b);
      return {};
    };
    const cfg = {
      controlUrl: "http://control.test",
      controlToken: "k",
      intelUrl: "http://intel.test",
      mlaPath: "/tmp/mla",
      auth: { mode: "shared-key" },
    } as unknown as CliConfig;
    await makeIntelAskFromCli(cfg, intelPostFn)(
      FIXTURE.input as unknown as Parameters<
        ReturnType<typeof makeIntelAskFromCli>
      >[0],
    );
    // packages/ask-core/ask_modes.test.js asserts this same string off this
    // same file, through the plain-fetch transport.
    expect(sent).toBe(FIXTURE.wire);
  });

  it("keeps the fixture honest about what it proves", () => {
    // The question carries a credential AND a deep source path on purpose. If a
    // later edit softened it to something with neither, both parity tests would
    // still pass while proving nothing.
    expect(FIXTURE.input.question).toContain("sk-proj-");
    expect(FIXTURE.wire).not.toContain("sk-proj-");
    // Redacted at the `retrieval` bar, not `full`: the path IS the retrieval key
    // and has to survive. `full` would leave "[REDACTED].tsx" here.
    expect(FIXTURE.wire).toContain("apps/console/app/settings/SettingsNav.tsx");
    // §8: the variable NAME is a retrieval key too, and outlives its value.
    expect(FIXTURE.wire).toContain("OPENAI_API_KEY=[REDACTED]");
  });

  it("pins the modules that build a /v1/ask body", () => {
    const builders = walk(SRC, [".ts", ".sh"])
      .filter((p) => {
        const src = read(p);
        return path.extname(p) === ".sh"
          ? shellCode(src).some((l) => l.includes("/v1/ask"))
          : stripComments(src).includes("/v1/ask");
      })
      .map(rel)
      .sort();
    expect(builders).toEqual([
      // Bash owns the Layer-2 enrichment pull (§6). It redacts the question
      // through `mla _internal redact-capture` BEFORE it truncates, so the
      // elision can never re-expose a secret the redactor removed.
      "hooks-template/user-prompt-submit.sh",
      // The CJS transport for `mla mcp`: a user-token bearer plus reactive
      // refresh, which ask-core's plain-fetch transport cannot carry. Locked to
      // ask-core's bytes by the fixture test above.
      "lib/mcp-fetchers.ts",
    ]);
  });

  it("pins the ask-core half: one builder, one socket, mandatory redaction", () => {
    // The second package is where the OTHER builder lives, and this suite's
    // SRC scan cannot see it. Without this, "no third builder" would be true
    // only of the half of the codebase the scan happens to walk.
    const prod = fs
      .readdirSync(ASK_CORE)
      .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
      .sort();
    const askers = prod.filter((f) =>
      stripComments(read(path.join(ASK_CORE, f))).includes("/v1/ask"),
    );
    expect(askers).toEqual(["ask_modes.js"]);
    const senders = prod.filter((f) =>
      namesGlobalFetch(read(path.join(ASK_CORE, f))),
    );
    expect(senders).toEqual(["ask_modes.js"]);

    const modes = read(path.join(ASK_CORE, "ask_modes.js"));
    expect(countOutboundCalls(modes)).toBe(1);
    // Redaction is applied in the payload literal itself and cannot be
    // injected away: there is no redactFn parameter to override.
    expect(stripComments(modes)).toMatch(
      /question:\s*redactForWire\(question\)/,
    );
    expect(stripComments(modes)).not.toMatch(/redactFn/);
    expect(stripComments(modes)).toMatch(/REDACT_PROFILE = "retrieval"/);
  });
});
