import { renderPlain } from "../lib/ask-render";
import { CliConfig, ConfigError, readConfig } from "../lib/config";
import { loadDocsCorpus } from "../lib/docs-corpus";
import {
  renderSearchHits,
  renderTopic,
  renderTopicList,
  renderUnknownTopic,
  resolveTopic,
  resolveWidth,
} from "../lib/docs-render";
import { docsSearch } from "../lib/docs-search";
import { HttpError, post } from "../lib/http";

/**
 * `mla docs`: the documentation surface (proposal 20260711 §6 offline, §7 AI).
 *
 *   mla docs                       list every topic
 *   mla docs <topic>               read one page (slug or short alias)
 *   mla docs search "<terms>"      deterministic lexical search over passages
 *   mla docs ask "<question>"      the AI surface (§7), needs `mla login`
 *
 * Everything except `ask` is pre-auth, offline, and deterministic: it reads the corpus
 * COMPILED INTO the binary (`lib/docs-corpus.data.ts`, generated from the SAME markdown
 * the website renders). No network, no config, no workspace, and no file read. A user
 * who cannot log in can still read the docs that explain why.
 *
 * `ask` is the AI half: Control-fronted, Intel-executed, system-funded. It is the
 * ONLY part of this command that can fail for a reason that is not the user's
 * fault, so it is the only part with a fallback: whenever the AI answer cannot be
 * produced, we degrade to the offline search of the SAME corpus, say so in a
 * banner, and exit 0. A docs command that dead-ends on "service unavailable" is a
 * docs command that fails exactly when the user is most stuck.
 *
 * Exit codes (§7.6):
 *   0  rendered something: an AI answer, an abstention, or a labeled offline fallback
 *   1  a well-formed request that cannot be served: unknown topic, no credentials,
 *      expired credentials, or a runtime fault
 *   2  malformed invocation (search with no terms, ask with no question)
 */

export interface DocsDeps {
  /** Injected in tests so rendering is asserted at a pinned width. */
  columns?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Injected in tests: reads ~/.meetless/cli-config.json. Throws if absent. */
  readConfig?: () => CliConfig;
  /** Injected in tests: the one network call this command makes. */
  askControl?: (cfg: CliConfig, body: DocsAskRequest) => Promise<DocsAskResponse>;
}

export interface DocsAskRequest {
  question: string;
  /** The sha256 of the corpus THIS binary bundles. Control refuses to answer against a different one. */
  corpusHash: string;
}

export interface DocsAskCitation {
  passageId: string;
  slug: string;
  title: string;
  headingPath: string[];
}

/**
 * Every business outcome is an HTTP 200 with a `status`. Only a malformed request
 * (400) and a rejected credential (401) are non-200, which is what lets the CLI
 * treat "rate limited" and "the model is down" as ordinary, renderable answers
 * instead of pushing them down an error path that would exit non-zero.
 */
export interface DocsAskResponse {
  status: "answered" | "abstained" | "corpus_mismatch" | "rate_limited" | "unavailable";
  /** Present for `answered` only. An abstention carries no prose; see ABSTENTION. */
  answer?: string;
  citations?: DocsAskCitation[];
  corpusHash?: string;
}

/**
 * The abstention. It is OUR sentence, not the model's.
 *
 * The server sends no prose when it abstains, on purpose and on both of its
 * abstention paths (the model emitted none, or its prose was uncitable and got
 * dropped). So this sits with the other §7.6 banners below, and an abstention reads
 * the same way every time instead of being whatever a model happened to say on the
 * one path where it said anything.
 */
const ABSTENTION = "The documentation does not cover that.";

/** Where a cited passage can be read in a browser. Mirrors the docs site routing. */
const DOCS_URL_BASE = "https://meetless.ai/docs";

/**
 * Control aborts its Intel call at 30s and answers with `unavailable`. The client
 * must outlive that, or it would abandon a request Control is about to answer and
 * report a network failure for a call that actually succeeded.
 */
const DOCS_ASK_TIMEOUT_MS = 35_000;

/** Control's DTO cap. Enforced here too, so an over-long question costs no round trip. */
const MAX_QUESTION_CHARS = 1000;

/**
 * The words that are NOT topics. Exported because the dispatcher needs the same
 * list to know where this command's free text begins (`wantsLeadingHelp`): a `-h`
 * inside a question must not be read as a plea for help. One list, so the router
 * below and the help scan can never disagree about what is a subcommand.
 */
export const DOCS_SUBCOMMANDS = ["search", "ask"] as const;

/**
 * Drop a single leading `--` from the query tokens, the POSIX escape hatch.
 *
 * There is exactly one question this surface cannot otherwise ask: one that IS a
 * help flag and nothing else (`mla docs ask -h`), which the leading-help scan claims
 * for help, correctly, because that is what it almost always means. `--` is the way
 * out: it is not a subcommand, so the scan stops there and never sees the `-h` behind
 * it, which makes `mla docs ask -- -h` a QUESTION. Node hands the `--` through to us
 * intact, so we drop it here; otherwise the question text would read `-- -h`.
 *
 * Only the leading one. A `--` inside the prose is prose (`mla docs ask what does --
 * mean`), and the shell has already done the only splitting anyone asked it to do.
 */
function stripEscape(tokens: string[]): string[] {
  return tokens[0] === "--" ? tokens.slice(1) : tokens;
}

export async function runDocs(argv: string[], deps: DocsDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.error ?? ((line: string) => console.error(line));
  const width = resolveWidth(deps.columns ?? process.stdout.columns);

  // `--help` in the LEADING position never reaches here: dispatch answers
  // `mla docs --help` and `mla docs ask --help` from the registry (T11). A help
  // flag that appears once the question has started is part of the question, and
  // arrives here intact.
  //
  // Neither `search` nor `ask` takes flags of its own. Every token after the
  // subcommand is query text, joined on spaces, which is what lets an unquoted
  // `mla docs ask what does --plain do` work at all. That is the contract; there
  // are no unknown flags to reject because there are no flags.
  const [first, ...rest] = argv;
  const query = stripEscape(rest).join(" ").trim();

  // `loadDocsCorpus` throws loudly if the compiled-in payload is malformed: a build
  // that mangled the corpus is broken, and silently degrading to "no docs found"
  // would hide it. Surface it as a runtime failure, not an empty page.
  let corpus;
  try {
    corpus = loadDocsCorpus();
  } catch (e) {
    err(`Documentation is unavailable in this build: ${(e as Error).message}`);
    err("This is a packaging bug. Please report it: mla bug report");
    return 1;
  }

  if (!first) {
    log(renderTopicList(corpus.docs, width));
    return 0;
  }

  if (first === DOCS_SUBCOMMANDS[0]) {
    if (!query) {
      err('Usage: mla docs search "<terms>"');
      return 2;
    }
    // A search that matches nothing is a valid answer, not a failure: it exits 0
    // and tells you where to go next.
    log(renderSearchHits(query, docsSearch(corpus.passages, query), width));
    return 0;
  }

  if (first === DOCS_SUBCOMMANDS[1]) {
    const question = query;
    if (!question) {
      err('Usage: mla docs ask "<question>"');
      err("");
      err("`ask` is reserved for the AI surface, so it is never read as a topic.");
      err("To read the page about the Ask feature itself: mla docs concepts/ask");
      return 2;
    }
    if (question.length > MAX_QUESTION_CHARS) {
      err(`Usage: mla docs ask "<question>" (max ${MAX_QUESTION_CHARS} characters, got ${question.length})`);
      return 2;
    }
    return runDocsAsk(question, corpus, width, log, err, deps);
  }

  const slug = resolveTopic(corpus.docs, first);
  const doc = slug ? corpus.docs.find((d) => d.slug === slug) : undefined;
  if (!doc) {
    err(renderUnknownTopic(corpus.docs, first));
    return 1;
  }

  log(renderTopic(doc, corpus.passages, width));
  return 0;
}

type Corpus = ReturnType<typeof loadDocsCorpus>;
type Emit = (line: string) => void;

/**
 * `mla docs ask "<question>"` (§7.3, §7.6).
 *
 * One request, five outcomes, and a floor under all of them. The floor is the
 * point: the corpus is already on this machine, so there is NO failure of ours
 * that justifies leaving the user with nothing. Whatever goes wrong, they get the
 * offline search over the same passages, with a banner that says plainly it is a
 * search and not an AI answer. Silent degradation would be the actual sin: an
 * offline lexical hit list, presented unlabeled, reads like the AI answered.
 */
async function runDocsAsk(
  question: string,
  corpus: Corpus,
  width: number,
  log: Emit,
  err: Emit,
  deps: DocsDeps,
): Promise<number> {
  // Auth is checked BEFORE the network call, not by interpreting its failure: a
  // logged-out user should never generate a request at all, and "you are not
  // logged in" must not be a thing we learn from a 401 we could have predicted.
  let cfg: CliConfig;
  try {
    cfg = (deps.readConfig ?? readConfig)();
  } catch (e) {
    // NO_CONFIG is the only load failure with no operator message worth keeping:
    // nothing is on disk, so "sign in first" IS the remediation.
    if (e instanceof ConfigError && e.code === "NO_CONFIG") return needsLogin(err);
    // Every other config failure already knows its own fix, and it is never "log
    // in". The sharpest example is a MEETLESS_CONTROL_TOKEN set while logged in:
    // that user IS signed in, and answering "run `mla login`" walks them straight
    // back into the same error. Print what config.ts wrote and get out of the way.
    err((e as Error).message);
    return 1;
  }
  if (cfg.auth.mode === "none") {
    return needsLogin(err);
  }

  const ask = deps.askControl ?? defaultAskControl;

  let res: DocsAskResponse;
  try {
    res = await ask(cfg, { question, corpusHash: corpus.corpusHash });
  } catch (e) {
    const error = e as HttpError;

    // The credential is gone or refused. This is the ONE class of failure the user
    // can fix, so it is the one class we refuse to paper over with a fallback.
    if (error.name === "NotLoggedInError") return needsLogin(err);
    if (error.status === 401 || error.status === 403) {
      err("Session expired: `mla login` again.");
      err("");
      err("The offline docs need no login:");
      err('  mla docs search "<terms>"');
      return 1;
    }
    if (error.name === "RefreshBusyError") {
      err(error.message);
      return 1;
    }
    // 404/405: the route is not THERE. That is not a contract disagreement, it is
    // deployment skew, and it is the expected state of a CLI that updated before
    // Control did (or before the edge allowlist rolled). It is the same class of
    // problem as a 5xx from the user's side, so it gets the same floor: bundled
    // docs, honestly labeled. Telling this user to file a bug report would collect
    // one report per user per deploy window, all of them noise.
    if (error.status === 404 || error.status === 405) {
      return offlineFallback(
        "The Meetless docs service may be updating. Showing bundled offline documentation instead.",
        question,
        corpus,
        width,
        log,
      );
    }
    // Any OTHER 4xx means the CLI and the server disagree about the contract we
    // both claim to implement (a rejected field, a bad payload). That is a bug in
    // one of us, and hiding it behind a friendly "unreachable" banner would keep it
    // hidden.
    if (typeof error.status === "number" && error.status >= 400 && error.status < 500) {
      err(`mla docs ask failed: ${error.message}`);
      err("This is likely a bug. Please report it: mla bug report");
      return 1;
    }
    // Everything else (no status = never reached the server; 5xx = server fault):
    // §7.6 row 6. The service being down is not the user's problem to solve.
    return offlineFallback(
      "Meetless is unreachable right now. Showing bundled offline documentation instead.",
      question,
      corpus,
      width,
      log,
    );
  }

  switch (res.status) {
    case "answered":
      log(renderAnswer(res));
      return 0;

    case "abstained":
      // An abstention is a real answer and the product's whole trust posture: we
      // would rather say nothing than say something uncitable. Exit 0, and hand the
      // user the deterministic surface that does not need the docs to have said it
      // in so many words.
      log(ABSTENTION);
      log("");
      log(renderSearchHits(question, docsSearch(corpus.passages, question), width));
      return 0;

    case "corpus_mismatch":
      // §7.6 row 4. Deliberately NOT "reinstall": the far more common cause is that
      // the SERVICE is mid-rollout and this binary is fine. Telling a current user
      // to reinstall would be wrong advice that also happens to be annoying.
      return offlineFallback(
        "Your bundled documentation differs from the service. Update MLA or try again after the service rollout. Showing bundled offline documentation instead.",
        question,
        corpus,
        width,
        log,
      );

    case "rate_limited":
      return offlineFallback(
        "You have reached the hourly limit for `mla docs ask`. Showing bundled offline documentation instead.",
        question,
        corpus,
        width,
        log,
      );

    case "unavailable":
    default:
      // Intel timed out, failed, or is unconfigured; Control collapses all of it
      // into one honest outcome (§7.6 row 7) rather than leaking which internal
      // service broke.
      return offlineFallback(
        "The AI answer is unavailable right now (the service may be updating). Showing bundled offline documentation instead.",
        question,
        corpus,
        width,
        log,
      );
  }
}

/** The single network call. Kept separate so tests never need a live Control. */
async function defaultAskControl(cfg: CliConfig, body: DocsAskRequest): Promise<DocsAskResponse> {
  return post<DocsAskResponse>(cfg, "/internal/v1/docs/ask", body, DOCS_ASK_TIMEOUT_MS);
}

function needsLogin(err: Emit): number {
  err("Sign in first: `mla login`.");
  err("");
  err("`mla docs ask` uses AI to answer from the documentation, which needs an account.");
  err("The rest of the docs are offline and need no login:");
  err('  mla docs search "<terms>"');
  err("  mla docs");
  return 1;
}

/**
 * The AI answer plus the passages it stands on. Every citation is rendered as a
 * place the user can GO (a command and a URL), not as an id they have to take on
 * faith. Control has already thrown away any citation it did not itself supply, so
 * a slug here always resolves.
 */
function renderAnswer(res: DocsAskResponse): string {
  const results = (res.citations ?? []).map((c) => ({
    path: crumb(c),
    hint: `mla docs ${c.slug}  |  ${DOCS_URL_BASE}/${c.slug}`,
  }));
  return renderPlain({ answer: res.answer ?? "", results });
}



function crumb(c: DocsAskCitation): string {
  const parts = [c.title, ...(c.headingPath ?? [])].filter((p, i, all) => p && all.indexOf(p) === i);
  return parts.join(" > ") || c.slug;
}

/**
 * The floor under every failure mode. The banner is printed to STDOUT, immediately
 * above the results it describes, so the label travels with the text it labels: a
 * user who pipes this into a file or scrolls past the first line must still be able
 * to tell an offline keyword search from an AI answer.
 */
function offlineFallback(
  banner: string,
  question: string,
  corpus: Corpus,
  width: number,
  log: Emit,
): number {
  log(banner);
  log("");
  log(renderSearchHits(question, docsSearch(corpus.passages, question), width));
  return 0;
}
