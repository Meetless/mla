import { CliConfig, ConfigError } from "../../src/lib/config";
import { DocsAskRequest, DocsAskResponse, runDocs } from "../../src/commands/docs";
import { loadDocsCorpus } from "../../src/lib/docs-corpus";

// `mla docs ask`: the AI half of the self-documenting surface (proposal 20260711
// §7.3, §7.6, T22-T25).
//
// The contract this file pins is the EXIT/FALLBACK table (§7.6), because that is
// the part a user feels:
//
//   exit 0  an AI answer, an abstention, or a LABELED offline fallback
//   exit 1  no credentials, dead credentials, or a genuine fault
//   exit 2  a malformed invocation
//
// Two properties are load-bearing and are asserted for every degraded outcome:
//
//   1. There is always a floor. The corpus is already on the machine, so no
//      failure of OURS (rate limit, rollout skew, dead model, dead network) is
//      allowed to leave the user with nothing.
//   2. The floor is never silent. A lexical hit list rendered without a banner
//      reads exactly like an AI answer. The banner is not decoration; it is the
//      difference between degrading and lying.
//
// The corpus is the REAL vendored one. Only the two seams that would need a live
// world are injected: the on-disk config and the one HTTP call.

const corpus = loadDocsCorpus();

interface Captured {
  out: string;
  err: string;
  code: number;
  calls: DocsAskRequest[];
}

function loggedIn(): CliConfig {
  return {
    controlUrl: "http://127.0.0.1:3006",
    auth: { mode: "user-token", accessToken: "t" },
  } as unknown as CliConfig;
}

async function ask(
  question: string,
  opts: {
    config?: () => CliConfig;
    respond?: (body: DocsAskRequest) => Promise<DocsAskResponse>;
  } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: DocsAskRequest[] = [];
  const code = await runDocs(["ask", question], {
    columns: 80,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    readConfig: opts.config ?? loggedIn,
    askControl: async (_cfg, body) => {
      calls.push(body);
      if (!opts.respond) throw new Error("the test did not expect a network call");
      return opts.respond(body);
    },
  });
  return { out: out.join("\n"), err: err.join("\n"), code, calls };
}

/** Every degraded outcome must say, in the output itself, that this is not the AI answer. */
function assertLabeledFallback(r: Captured): void {
  expect(r.code).toBe(0);
  expect(r.out).toContain("Showing bundled offline documentation instead.");
  // And it must actually have searched: a banner over an empty page is not a floor.
  expect(r.out).toContain("mla docs");
}

describe("mla docs ask: authentication", () => {
  it("refuses to make a network call when there are no credentials", async () => {
    const r = await ask("how do I sign in?", {
      config: () => ({ auth: { mode: "none" } }) as unknown as CliConfig,
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain("Sign in first: `mla login`.");
    // Checked BEFORE the request, never learned FROM a 401 we could have predicted.
    expect(r.calls).toHaveLength(0);
    // The offline surface still works without an account, and a stuck user needs to
    // hear that from the command that just turned them away.
    expect(r.err).toContain('mla docs search "<terms>"');
  });

  it("treats a missing config file the same as being logged out", async () => {
    const r = await ask("how do I sign in?", {
      // Exactly what `readConfig` throws when ~/.meetless/cli-config.json is absent.
      config: () => {
        throw new ConfigError("No config found. Run: mla init ...", "NO_CONFIG");
      },
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain("Sign in first: `mla login`.");
    expect(r.calls).toHaveLength(0);
  });

  it("surfaces a config fault verbatim instead of blaming it on being logged out", async () => {
    // `readConfig` also throws for a CORRUPT config, an unknown auth.mode, and the
    // MEETLESS_CONTROL_TOKEN-while-logged-in hard error. Each of those messages already
    // carries its own exact remediation, and "Sign in first: `mla login`." is the wrong
    // one for all three: a user with a mangled config who runs `mla login` writes a new
    // token into the same broken file and lands right back here.
    const r = await ask("how do I sign in?", {
      config: () => {
        throw new ConfigError(
          "MEETLESS_CONTROL_TOKEN is set but you are logged in. Unset it or run `mla logout`.",
        );
      },
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain("MEETLESS_CONTROL_TOKEN is set but you are logged in");
    expect(r.err).not.toContain("Sign in first");
    expect(r.calls).toHaveLength(0);
  });

  it("tells an expired session to log in again, and does NOT fall back", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => {
        const e = new Error("Your CLI login expired. Run `mla login`.") as Error & { status: number };
        e.status = 401;
        throw e;
      },
    });

    // The one failure class the user can actually fix. Papering over it with an
    // offline search would hide the ONE thing they need to do.
    expect(r.code).toBe(1);
    expect(r.err).toContain("Session expired: `mla login` again.");
    expect(r.out).not.toContain("Showing bundled offline documentation");
  });
});

describe("mla docs ask: the request", () => {
  it("sends the question and the hash of the corpus THIS binary bundles", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => ({ status: "abstained", answer: "" }),
    });

    expect(r.calls).toEqual([
      { question: "how do I sign in?", corpusHash: corpus.corpusHash },
    ]);
    // The hash is what lets the server refuse to answer against a corpus whose
    // passage ids this binary cannot resolve. A blank one would defeat the gate.
    expect(corpus.corpusHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an over-long question locally instead of spending a round trip", async () => {
    const r = await ask("x".repeat(1001));

    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(r.err).toContain("max 1000 characters");
  });

  it("an UNQUOTED question keeps its flag words, `-h` included", async () => {
    // The whole point of a docs surface is that you can ask it what a flag does. An
    // unquoted question arrives as one argv token per word, so `-h` shows up as a
    // bare token; the dispatcher used to read that as a plea for help and print the
    // help screen instead of asking. `search` and `ask` have no flags of their own:
    // everything after the subcommand is the query, verbatim.
    const calls: DocsAskRequest[] = [];
    const code = await runDocs(["ask", "what", "does", "-h", "do", "on", "--plain", "runs?"], {
      columns: 80,
      log: () => {},
      error: () => {},
      readConfig: loggedIn,
      askControl: async (_cfg, body) => {
        calls.push(body);
        return { status: "abstained", answer: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { question: "what does -h do on --plain runs?", corpusHash: corpus.corpusHash },
    ]);
  });

  it("POSIX `--` escapes a question that IS a help flag, and does not end up in the question", async () => {
    // The one question the leading-help scan claims for itself is a bare `-h`. `--` is
    // the way out, and it only works if we drop it: leaving it in would send the model
    // the question "-- -h", which is not what anyone typed.
    const calls: DocsAskRequest[] = [];
    const code = await runDocs(["ask", "--", "-h"], {
      columns: 80,
      log: () => {},
      error: () => {},
      readConfig: loggedIn,
      askControl: async (_cfg, body) => {
        calls.push(body);
        return { status: "abstained", answer: "" };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{ question: "-h", corpusHash: corpus.corpusHash }]);
  });
});

describe("mla docs ask: an answer", () => {
  it("renders the prose and turns every citation into a place you can go", async () => {
    const cited = corpus.passages[0];
    const r = await ask("how do I sign in?", {
      respond: async () => ({
        status: "answered",
        answer: "Run `mla login`.",
        citations: [
          {
            passageId: cited.passageId,
            slug: cited.slug,
            title: cited.title,
            headingPath: cited.headingPath,
          },
        ],
      }),
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Run `mla login`.");
    expect(r.out).toContain("Citations (1):");
    // A citation the reader cannot open is an id they have to take on faith. Both
    // affordances: the offline command and the URL.
    expect(r.out).toContain(`mla docs ${cited.slug}`);
    expect(r.out).toContain(`https://meetless.ai/docs/${cited.slug}`);
    // An AI answer is NOT a fallback and must never wear the fallback's banner.
    expect(r.out).not.toContain("Showing bundled offline documentation");
  });
});

describe("mla docs ask: an abstention is an answer", () => {
  it("exits 0, says the docs do not cover it, and hands over the deterministic surface", async () => {
    // The server's REAL abstention: a status and nothing else. It never sends prose
    // when it abstains (the model emits none, and prose that failed citation
    // validation is exactly what it refuses to show), so the sentence is ours.
    const r = await ask("what does --turbo do?", {
      respond: async () => ({ status: "abstained" }),
    });

    // "I don't know" is the product's trust posture applied to our own manual. It
    // is a successful run, not an error.
    expect(r.code).toBe(0);
    expect(r.out).toContain("The documentation does not cover that.");
    // And it does not dead-end: lexical search can still surface a page the model
    // would not assert an answer from.
    expect(r.out).toContain("mla docs");
  });

  it("says the SAME sentence no matter what a server puts in the body", async () => {
    // An abstention reads identically every time. A server that (wrongly) shipped
    // prose on this path would be putting model text where a fixed banner belongs,
    // and the abstention is the one place we will not let the model speak.
    const r = await ask("what is the airspeed of a swallow?", {
      respond: async () => ({ status: "abstained", answer: "sure, use --turbo!" }),
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("The documentation does not cover that.");
    expect(r.out).not.toContain("--turbo");
  });
});

describe("mla docs ask: every failure has a labeled floor (§7.6)", () => {
  it("a corpus mismatch blames neither side and never says 'reinstall'", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => ({ status: "corpus_mismatch", corpusHash: "f".repeat(64) }),
    });

    assertLabeledFallback(r);
    expect(r.out).toContain(
      "Your bundled documentation differs from the service. Update MLA or try again after the service rollout.",
    );
    // The likeliest cause is a service mid-rollout against a CLI that is perfectly
    // current. "Reinstall" would be wrong advice AND annoying advice.
    expect(r.out.toLowerCase()).not.toContain("reinstall");
  });

  it("a rate limit degrades instead of erroring", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => ({ status: "rate_limited" }),
    });

    assertLabeledFallback(r);
    expect(r.out).toContain("hourly limit");
  });

  it("an unavailable model degrades instead of erroring", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => ({ status: "unavailable" }),
    });

    assertLabeledFallback(r);
    expect(r.out).toContain("The AI answer is unavailable right now");
  });

  it("an unreachable service degrades instead of erroring", async () => {
    const r = await ask("how do I sign in?", {
      // A fetch-level failure: no HTTP status, because we never reached a server.
      respond: async () => {
        throw new TypeError("fetch failed");
      },
    });

    assertLabeledFallback(r);
    expect(r.out).toContain("Meetless is unreachable right now");
  });

  it("a 5xx degrades instead of erroring", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => {
        const e = new Error("POST /internal/v1/docs/ask -> HTTP 502: bad gateway") as Error & { status: number };
        e.status = 502;
        throw e;
      },
    });

    assertLabeledFallback(r);
  });

  it("the fallback searches the question the user actually asked", async () => {
    const r = await ask("how do I ingest a session", {
      respond: async () => ({ status: "rate_limited" }),
    });

    // The floor is only a floor if it answers the same question. Falling back to a
    // topic list (or to nothing) would be a non-answer wearing an answer's exit code.
    expect(r.out).toContain("how do I ingest a session");
  });

  it("a 404 (route not deployed yet) degrades instead of nudging a bug report", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => {
        const e = new Error("POST /internal/v1/docs/ask -> HTTP 404: Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      },
    });

    // A 404/405 here is OUR deploy skew, not a contract bug: an `mla` that shipped
    // ahead of the Control route (or an edge allowlist that has not learned it yet)
    // hits exactly this. Telling that user to file a bug report is telling them to
    // report our rollout window. Degrade, and let the next release fix it silently.
    assertLabeledFallback(r);
    expect(r.out).toContain("The Meetless docs service may be updating");
    expect(r.err).not.toContain("mla bug report");
  });

  it("surfaces a contract violation (4xx) as a bug rather than hiding it behind a banner", async () => {
    const r = await ask("how do I sign in?", {
      respond: async () => {
        const e = new Error("POST /internal/v1/docs/ask -> HTTP 400: corpusHash must match") as Error & {
          status: number;
        };
        e.status = 400;
        throw e;
      },
    });

    // The CLI and the server disagreeing about the wire contract is a bug in one of
    // us. A friendly "service unreachable" banner would keep it invisible forever.
    expect(r.code).toBe(1);
    expect(r.err).toContain("mla bug report");
    expect(r.out).not.toContain("Showing bundled offline documentation");
  });
});
