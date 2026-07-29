/**
 * Egress secret redactor, ESM plane.
 *
 * FOURTH MIRROR of the one parity-locked redactor (principle 7 of
 * notes/20260528-mla-logging-and-tracing-proposal.md). The other three are
 *   - meetless-cli/packages/cli/src/lib/redactor.ts   (TypeScript, CommonJS build)
 *   - apps/control/src/core/services/redactor.ts      (TypeScript, control)
 *   - intel/app/observability/redaction.py            (Python)
 * and the four are locked together by hand-mirrored PARITY_CASES fixtures:
 * redactor.test.js (here), redactor-parity.spec.ts (x2), test_redaction_parity.py.
 * Change a pattern in one, change it in all four IN THE SAME COMMIT.
 *
 * Why a fourth copy instead of importing one of the three: `mla` compiles to
 * CommonJS and loads this package through a bundled CJS artifact or a
 * `new Function("u", "return import(u)")` true-dynamic import (see
 * packages/cli/src/commands/ask.ts). Its redactor is imported synchronously by
 * 17 CJS modules, so it cannot become ESM-only, and this package is
 * deliberately dependency-free, so it cannot reach back into the CLI. The
 * duplication is the price of the CJS/ESM boundary; the shared fixture is what
 * makes drift loud instead of silent.
 *
 * ONLY `redact` is mirrored. The block-on-detect scanners (scanForSecrets,
 * scanForCredentials) and redactPayload live on the CLI plane alone because
 * nothing here gates a file upload or walks a payload tree. The parity fixture
 * covers exactly what is mirrored.
 */

export const REDACTED = "[REDACTED]";

// Order matters: env_assignment runs first so KEY=value pairs are handled
// before the token literals, which come second for cases without an = sign.
// High-entropy heuristic runs last to catch generic session tokens that the
// prefix matchers miss.
//
// Third element is the REPLACEMENT. Every pattern replaces its whole match with
// the marker except env_assignment, which keeps the variable NAME and the
// separator and replaces only the value (groups: 1 name, 2 separator, 3 value).
const PATTERNS = [
  // env_assignment is TWO entries sharing one rule id, because "an env var holding a
  // credential" and "a credential-named field in any casing" are different claims and
  // only the second one can be made safely case-insensitively.
  //
  // A (this entry) is the env-var claim, and it is case-SENSITIVE ON PURPOSE. Every
  // alternative below is written in SCREAMING_SNAKE, which IS the signal that this is an
  // environment variable rather than an ordinary program identifier. The rule used to
  // carry `/i`, which deleted that signal: `[A-Z][A-Z0-9_]*` then matched `scope_key`,
  // and the rule quietly became "any identifier ending in key, token, secret or
  // password". Measured on the 2094-note vault, the flag took the rule from 46 notes to
  // 140, and what it added was domain vocabulary, not credentials: `scope_key` (162
  // hits), `run_key` (29), `idempotency_key` (25), `issue_key` (15), `jira_key` (15),
  // `inflight_token` (12). Under `block_on_detect` egress each is a REFUSED NOTE, so one
  // flag character made 94 notes ungovernable. Same trap as `bearer` below: a character
  // class that encodes casing and a `/i` cannot both be right.
  //
  // The prefix is OPTIONAL, and that is a leak being closed rather than a style
  // choice. It used to be mandatory (`[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|...)`),
  // so `APP_SECRET=<v>` was REFUSED while `SECRET=<the identical v>` EGRESSED: the
  // credential word only counted as a name when something else was glued in front
  // of it. That is backwards on its own terms. `SECRET` is not a weaker credential
  // claim than `APP_SECRET`, it is a stronger one, because no qualifier is left to
  // make it mean something else, and it is the most direct way anyone writes it.
  // `high_entropy_token` does match those lines and rescues nothing: it is not in
  // CREDENTIAL_RULE_IDS, so under `block_on_detect` (where the body is never
  // rewritten) it produces no refusal at all and the value ships intact.
  //
  // The leading `\b` is what keeps the optional prefix honest: there is no word
  // boundary before the `KEY` inside `MONKEY`, so `MONKEY=`, `DONKEY=` and
  // `TURNKEY=` do not match, while `MY-KEY=` does (a hyphen is not a word
  // character), which is correct.
  //
  // Cost, measured on the 2094-note vault BEFORE the change was applied: exactly 2
  // notes, both prose labels rather than assignments (`KEY: obligation_strength and
  // intent are independent axes`, `INV-EVIDENCE-NO-RAW-SECRET: agent/session/file
  // evidence`). Both values are letters and punctuation with no digit, which is the
  // shape a diceware passphrase also has, so exempting them would reopen a hole we
  // already refused to open. Two refused documents is the price.
  //
  // The widening belongs in A ONLY. Measured per bare word against the same vault,
  // B's case-insensitive plane would take `key` 76 new hits across 30 notes
  // (`A1-XXXXXX-YYYYYYY-7392`, `event.someIdentifier`), `token` 8 across 7, `secret`
  // 2. In 2094 real notes not one lowercase bare `secret` or `token` carried a
  // credential-shaped value. So the claim is narrow and exact: the BARER the name,
  // the more it has to look like an environment variable, and SCREAMING_SNAKE is
  // that signal.
  //
  // The value side carries the "a REFERENCE is not a VALUE" guard, shared with B below
  // and spelled out once at REFERENCE_GUARD.
  [
    "env_assignment",
    /\b(?!(?![A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|PASSWORD|PASSWD|PWD|PASSPHRASE)[^\S\r\n]*[:=])[A-Za-z0-9_.-]*[^\S\r\n]*[:=][^\S\r\n]*(?:'[A-Za-z]{1,12}'|"[A-Za-z]{1,12}"|[A-Za-z]{1,12})(?=[\s,;)\]}`'"]|$))((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)([^\S\r\n]*[:=][^\S\r\n]*)((?!['"]?(?:\$[({A-Za-z_]|\{\{|<|\[REDACTED\]))(?!['"]?[A-Za-z0-9_\-+/=]*\.\.\.['"]?(?=[\s,;)\]}`'"]|$))(?!['"]?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|token|key|secret|password|pwd)['"]?(?=[\s,;)\]}`'"]|$))(?=[^\s]*[A-Za-z0-9])(?:'[^']*'|"[^"]*"|\S+))/gm,
    // Keep the name. It is not a credential, and it is usually the primary
    // retrieval key: "OPENAI_API_KEY=[REDACTED]" still answers "which key was
    // set?", while a bare "[REDACTED]" answers nothing. Residual: the entropy
    // sweep runs after and does not know the name was deliberately preserved,
    // so a 32+ char name can still be eaten under "full" (never worse than the
    // previous whole-match behaviour; "retrieval" keeps such names).
    `$1$2${REDACTED}`,
  ],
  // B: the same id, for a credential-named field in ANY casing. Dropping `/i` from A
  // would also drop `api_key` (31 hits), `password` (8), `client_secret`,
  // `aws_secret_access_key`, `private_key`: all real credentials, routinely lowercase in
  // YAML, JSON, Python and shell. So the case-insensitive half survives, but it has to
  // EARN it: the noise sat entirely in the GENERIC suffix, where `key` means "identifier"
  // (`scope_key`, `issue_key`). Here the name must say credential in WORDS; a bare `_key`
  // or `_token` suffix is not enough. This entry carries NO uppercase character class and
  // no lookahead over one, so the `/i` trap cannot structurally apply to it.
  //
  // The value side needs its own guard, because a credential word appears in code as
  // often as in config: `accessToken: string;` is a type annotation. The guard is SHAPE,
  // not a dictionary of type names, because a dictionary is a thing an author can talk
  // their way past: the value must contain at least one alphanumeric, AND a BARE
  // (unquoted) value must be literal-shaped end to end. A quoted value is a literal by
  // construction. Net over the vault: A+B refuse 59 notes where the single `/gim` rule
  // refused 140.
  //
  // B also closes a gap A never covered. `\bPASSWORD` cannot match inside `PGPASSWORD`
  // (no word boundary between `PG` and `PASSWORD`), and every other alternative in A
  // requires a literal `_` before the suffix, so `PGPASSWORD=<pw>`, `apiKey=<v>` and
  // `clientSecret=<v>` were never redacted by ANY plane. `PGPASSWORD=` is in our own
  // documented prod psql command.
  //
  // A bare lowercase identifier after a credential word used to be redacted too, so
  // `api_key: str` lost its `str`. That residual is now closed by BARE_WORD_GUARD
  // below, which splits it by WHO ISSUES THE VALUE.
  //
  // REFERENCE_GUARD (both entries): a REFERENCE is not a VALUE.
  //
  //   (?!['"]?(?:\$[({A-Za-z_]|\{\{|<|\[REDACTED\]))              a sigil
  //   (?!['"]?[A-Za-z0-9_\-+/=]*\.\.\.TAIL)                       an elision
  //   (?!['"]?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*_(?:TOKEN|KEY|…)TAIL) a name
  //   (?=[^\s]*[A-Za-z0-9])                                       not empty
  //
  // where TAIL is `['"]?(?=[\s,;)\]}`'"]|$)`.
  //
  // A's value used to be a bare `\S+`, which meant the branch with the STRONGEST name
  // signal had the WEAKEST value test: anything after the `=` refused the document. A
  // setup doc is the most credential-shaped document a team owns and it is built almost
  // entirely out of things that cannot be credentials. Measured over the vault, this
  // freed 14 notes: `SENDGRID_API_KEY=<sendgrid-key>`, `REDIS_PASSWORD=${_REDIS_PASSWORD}`,
  // `EVENT_KEY="$(gen-secret 32)"`, `INGEST_SECRET=${{ secrets.INGEST_SECRET }}`,
  // `OPENAI_API_KEY=...`, `GH_TOKEN=[REDACTED]`.
  //
  // `$(cmd)` names a command, `${VAR}` and `{{ x }}` name a variable, `<x>` is not legal
  // in a credential literal in any format we ship, a value with no alphanumeric anywhere
  // is an elision, and `[REDACTED]` is this redactor's own output (without that arm, an
  // already-redacted document is refused for carrying the proof it was redacted). Every
  // clause is a shape; none of them needs to know an English word.
  //
  // Two shapes are deliberately NOT references, and both are pinned in the spec:
  //   * `$` then a DIGIT is a bcrypt hash (`$2b$10$...`). A shell variable cannot start
  //     with a digit, which is why the class is `[({A-Za-z_]` and not a bare `\$`.
  //   * a backtick is markdown formatting, and inline code is exactly how a real key
  //     gets pasted into a note. Backticks are absent from the guard on purpose.
  //
  // Known edge, chosen not missed: the alphanumeric lookahead reads the first
  // whitespace-free run, so `KEY=' .env'` (quote then space) is exempt. Tightening it to
  // look inside the quotes costs two real false positives in the vault and buys only a
  // leading-space password, a shape nobody writes.
  //
  // The sigil arm read "a reference" too narrowly, and the vault found the two shapes it
  // missed. Measured after it shipped, 45 of the 50 still-refused notes were refused
  // here, and the residual sorted into exactly two more references that no sigil marks:
  //
  //   an ELIDED PREFIX   OPENAI_API_KEY=sk-...   SLACK_BOT_TOKEN=xoxb-...
  //                      LANGFUSE_PUBLIC_KEY=pk-lf-86...   api_key="om_sk_..."
  //   a NAME             CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN
  //                      apiKey: process.env.POSTHOG_API_KEY   self.api_key = api_key
  //
  // `OPENAI_API_KEY=...` was already exempt and `OPENAI_API_KEY=sk-...` was not, which is
  // the same author doing the same thing. An ellipsis is the mark of text REMOVED, and a
  // prefix is what survives elision; keeping the first six characters of a key does not
  // make those six characters a key. A name is the older half of the same idea: the sigil
  // exempted `$MEETLESS_CONTROL_TOKEN` because the `$` says "variable", then refused
  // `CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN`, where the `$` is absent only because the
  // language does not use one. The sigil was never the evidence; the SHAPE is.
  //
  // Hyphens are deliberately NOT identifier characters in the name arm. No language we
  // ship writes a variable with a hyphen, so the restriction costs nothing and keeps
  // `xoxb-test-bot-token`, `test-signing-secret` and `your-secret-key` refused. Both arms
  // carry a TAIL anchor so the exemption covers the WHOLE value and never a prefix of
  // one: `API_KEY=SECRET_KEYabc123def456` is still a refusal. Measured over the vault:
  // 30 matches freed, notes carrying a hit 45 -> 34, zero true positives freed. The
  // unelided sibling `sk-proj-AbCdEf…(33)` in the same note is still refused.
  //
  // Accepted residual: a password that is itself spelled like a credential name
  // (`api_key = my_secret_key`) is now exempt. Same trade this rule already makes in the
  // other direction, and every instance in the vault is a placeholder.
  //
  // BARE_WORD_GUARD (both entries): a bare WORD is not a VALUE, unless a human chose it.
  //
  //   (?! (?! NAME (?:password|passwd|pwd) SEP ) NAME SEP BAREWORD TAIL )
  //
  // where BAREWORD is `'[A-Za-z]{1,12}'`, `"[A-Za-z]{1,12}"` or a bare `[A-Za-z]{1,12}`,
  // and TAIL is `(?=[\s,;)\]}`'"]|$)`. Read it as: refuse to match here when a
  // NON-password name is followed by a separator and a bare alphabetic word.
  //
  // The shape claim: a value that is letters-only and at most 12 characters is not a
  // credential. Not one true positive in the 2094-note vault contradicts it, and the
  // format definitions say why. Base64 and base64url mix case AND carry digits, hex IS
  // digits, a uuid carries hyphens, and every provider prefix this file scans for
  // (`sk-`, `xoxb-`, `ghp_`, `AKIA`) carries punctuation or a digit inside four
  // characters. A machine-issued credential cannot be spelled with 26 letters. The
  // 12-character ceiling keeps a letters-only passphrase blocked.
  //
  // The password family is exempted FROM the exemption, and that half is load-bearing.
  // A key, token or secret is MACHINE-issued, so a bare word is never the credential. A
  // password is HUMAN-chosen, and a short lowercase word is the commonest real password
  // shape there is: `PGPASSWORD=postgres` sits in our own prod psql runbook. So the
  // guard's head re-tests the name and steps aside for the password family. It is a
  // nested lookahead rather than a lookbehind because the Python plane supports only
  // FIXED-width lookbehind, and it holds only non-capturing groups so the `$1$2`
  // numbering is untouched. Both casings are spelled out because the same literal has to
  // work under A's case-sensitive `/gm` and B's `/gi`.
  //
  // The value side is three explicit arms rather than an optional quote, because
  // `['"]?[A-Za-z]{1,12}['"]?` freed `SECRET_FOO='bar baz'`: it matched `'bar` and TAIL
  // read the space INSIDE the quotes as a terminator. A quoted value has to be tested
  // whole.
  //
  // Measured over the vault: 23 matches freed, ZERO of them in the password family,
  // notes carrying an env_assignment hit 34 -> 19, 15 notes fully released. What it
  // frees is `api_key: str`, `accessToken: string`, `ANTHROPIC_AUTH_TOKEN=ollama`,
  // `RATE_LIMIT_KEY = "rateLimit"`, and this redactor's own marker tail:
  // `[REDACTED_SECRET:JWT]` parses as an assignment, so redaction was not idempotent.
  //
  // SAME_LINE (both entries, all three `[:=]` sites): a value lives on the SAME LINE as
  // its name. The separator was `\s*[:=]\s*`, and `\s` matches `\n`, so a name that ENDS
  // a line reached across the break and adopted the first token of the next one. What
  // that caught in the vault was a Python block opener:
  //
  //   if self.idempotency_strategy == IdempotencyStrategy.UPSERT_BY_KEY:
  //       key_parts = [args.get(f) for f in self.idempotency_key_fields]
  //
  // The colon is syntax, not an assignment, and `key_parts` is an identifier on the next
  // line. `[^\S\r\n]` is whitespace that is not a line break, so the separator still
  // spans spaces, tabs, form feeds and unicode spaces and stops at the newline; it is
  // spelled the same in JS and Python `re`.
  //
  // The guard's two `[:=]` sites are mirrored so both halves agree on what a line is.
  // Measured: mirroring is invisible ONCE the rule is same-line (rule-only and rule+guard
  // produce identical match sets over the vault), but it is NOT inert on its own. Mirror
  // the guard while leaving the rule cross-line and 3 vault spans become refusals, so the
  // guard is today reaching across a newline to exempt matches the rule reached across a
  // newline to make. Two halves of one claim should not disagree about what a line is.
  //
  // Measured over the vault: 2 matches freed, both the snippet above, ZERO password-family
  // matches freed. A per-line scan is structurally blind to this class: the defect only
  // exists when two lines are read together, which is exactly how a document is sent.
  //
  // PHRASE (TRIED, MEASURED, REJECTED: do not retry without reading this). The next idea
  // after BARE_WORD is "a PHRASE is not a value": widen the arm to
  // `[A-Za-z]{1,12}(?:[-_][A-Za-z]{1,12})*` so the 12-letter ceiling applies PER SEGMENT,
  // on the theory that a machine-issued key is one high-entropy RUN and letter-words
  // joined by `-` or `_` are how a human spells a placeholder. It measures beautifully:
  // 19 vault matches freed, ZERO in the password family, notes carrying an env_assignment
  // hit 17 -> 9, and every genuinely credential-shaped value in the vault stays refused.
  //
  // It is still wrong, and the vault is exactly what hid that. Both falsifications came
  // from this repo's own suite, not from the corpus:
  //
  //   1. It frees the issuer-prefixed family. `sk-live-abcdefgh`, `sk-ant-short`,
  //      `whsec-abcdef`, `sk-proj-abcdefgh` and `ghp_x` are all letter-words joined by
  //      `-` or `_`, so the widened arm exempts every one of them. `provider_token` only
  //      re-catches them once the body reaches its own length floor (`sk-live-abcdefghijkl`
  //      and up), so the layered defence has a hole precisely where the value is short.
  //   2. It deletes the entropy ceiling that makes BARE_WORD safe. BARE_WORD exempts at
  //      most 12 letters, under 9 bytes, and no issuer mints a 9-byte credential: that
  //      bound IS the argument. PHRASE has no bound at all, so
  //      `SECRET=alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel` passes through with
  //      roughly 100 bits in it. A diceware passphrase is a real credential, and `SECRET`,
  //      `API_KEY` and `ACCESS_TOKEN` are not in the password family, so nothing catches it.
  //
  // The vault read clean only because every true positive in it happens to carry a digit.
  // That is a fact about this corpus, not about credentials. Bounding the phrase does not
  // rescue it: a 24-character cap still exempts a five-word, ~64-bit passphrase and still
  // misses all five short issuer-prefixed values above.
  //
  // So the claim does not survive contact: a phrase IS a valid credential shape. Telling
  // `your-app-client-secret` from `correct-horse-battery-staple` requires intent, and
  // reading intent means a dictionary of placeholder words, which is the class rejected at
  // the start of this work. Refusing the ~8 extra documents is the cheaper error: a false
  // positive costs a refused document, a false negative is a leak. The behaviour this
  // paragraph declines to change is pinned in `redactor-env-assignment.spec.ts` under
  // "a PHRASE is a credential shape, not a placeholder".
  [
    "env_assignment",
    /\b(?!(?![A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|PASSWORD|PASSWD|PWD|PASSPHRASE)[^\S\r\n]*[:=])[A-Za-z0-9_.-]*[^\S\r\n]*[:=][^\S\r\n]*(?:'[A-Za-z]{1,12}'|"[A-Za-z]{1,12}"|[A-Za-z]{1,12})(?=[\s,;)\]}`'"]|$))([A-Za-z0-9_-]*(?:api[_-]?key|api[_-]?token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|access[_-]?key(?:[_-]?id)?|secret[_-]?(?:access[_-]?)?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|client[_-]?secret|app[_-]?secret|signing[_-]?secret|webhook[_-]?secret|password|passwd|passphrase))([^\S\r\n]*[:=][^\S\r\n]*)((?!['"]?(?:\$[({A-Za-z_]|\{\{|<|\[REDACTED\]))(?!['"]?[A-Za-z0-9_\-+/=]*\.\.\.['"]?(?=[\s,;)\]}`'"]|$))(?!['"]?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|token|key|secret|password|pwd)['"]?(?=[\s,;)\]}`'"]|$))(?=[^\s]*[A-Za-z0-9])(?:'[^']*'|"[^"]*"|[A-Za-z0-9_\-./+=:~]+(?=\s|$)))/gi,
    `$1$2${REDACTED}`,
  ],
  // The tail must be credential-SHAPED, not merely word-shaped. A bare
  // `[A-Za-z0-9._\-+/=]+` matches any English word, so this rule used to fire on
  // "Bearer token", "Basic Admin" and "basic implementation": measured, 517 hits
  // across 262 of 2094 real notes, not one of them a credential that `provider_token`,
  // `jwt` or the entropy sweep did not already own. Under `block_on_detect` egress that
  // is not over-redaction, it is 262 documents refused at the boundary.
  //
  // So the tail must clear a length floor AND must either carry a digit or base64 `=`
  // padding, or mix upper and lower case. Prose fails all three; base64, hex and
  // prefixed opaque tokens pass.
  //
  // The floor is PER SCHEME, because the two schemes carry different payloads:
  //   Bearer: 16, the same floor `provider_token` uses for `sk-…` just below. No real
  //           bearer token is shorter.
  //   Basic:  12, because the payload is base64("user:pass") and base64 quantises to 4
  //           characters per 3 bytes. A 16 floor needs a 10-byte pair, so it MISSES
  //           `Basic dXNlcjpwYXNz` ("user:pass"), `Basic cm9vdDp0b29y` ("root:toor")
  //           and every other pair under 10 bytes. Measured on the same 2094 notes,
  //           taking Basic from 16 to 12 costs exactly 2 further false positives and
  //           closes every short pair except base64("a:b"), a 1-char password nobody
  //           has. That is the whole rule at 4 hits in 2094 notes, 3 of them prose and
  //           1 a genuine 67-char opaque token.
  //
  // Those 3 are accepted rather than grown into a dictionary: a CamelCase phrase after a
  // scheme keyword is not distinguishable from a base64 payload by shape, and the errors
  // point the safe way (a refused note, never a leaked header).
  //
  // The keyword is SPELLED case-insensitively instead of carrying `/i`, because `/i`
  // also makes `[A-Z]` match lowercase, which collapses the mixed-case lookahead into
  // "contains a letter" and silently reinstates the whole defect. It has to stay
  // case-insensitive either way: real headers carry `bearer <hex>` and `BEARER <token>`.
  [
    "bearer",
    /\b(?:[Bb][Ee][Aa][Rr][Ee][Rr]\s+(?=[A-Za-z0-9._\-+/=]{16,})|[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9._\-+/=]{12,}))(?:(?=[A-Za-z._\-+/]*[0-9=])|(?=[a-z0-9._\-+/=]*[A-Z])(?=[A-Z0-9._\-+/=]*[a-z]))[A-Za-z0-9._\-+/=]+/g,
    REDACTED,
  ],
  [
    "provider_token",
    /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{20,}|lf_(?:sk|pk)_[A-Za-z0-9]{20,})\b/g,
    REDACTED,
  ],
  // A JWT is a live credential and must go WHOLE. The entropy heuristic cannot
  // do it: the three segments are split by "." (outside its token class), and
  // only the header clears the 32-char floor, so entropy alone yields
  // "[REDACTED].<claims>.<signature>" and leaks the claims and the signature.
  ["jwt", /\beyJ[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, REDACTED],
  // COOKIE_GRAMMAR. This rule used to be `/(Set-)?Cookie:\s*[^\r\n]+/gi`: the literal
  // text "cookie:", then the rest of the line, with no test anywhere for whether a
  // cookie is being SET. Measured over the vault it fired 23 times across 6 notes and
  // not one hit was a cookie value. Sixteen were ASCII sequence diagrams in
  // `20260217-console-auth.md` (`Cookie: ml_access=EXPIRED`, `Set-Cookie: ml_refresh=;`,
  // `Cookie: ml_access, ml_refresh`), the rest were prose ("cookie: page fires 200 …"),
  // a curl example (`Cookie: ml_access=${token}`) and this rule's own source quoted in
  // a proposal. Under `block_on_detect` that is 6 refused documents, including the one
  // document that answers "how does console auth work".
  //
  // Two facts from RFC 6265 fix it without a word list:
  //
  //   1. A header is `name=value` pairs. A sentence containing "cookie:" has no pair,
  //      and `Cookie: a, b` names two cookies while setting neither.
  //   2. `Set-Cookie` carries exactly ONE pair; everything after the first `;` is an
  //      attribute (`Path=/`, `Max-Age=1209600`, `SameSite=Lax`). Attributes are
  //      grammar, never secrets. So the Set-Cookie form tests its FIRST pair only,
  //      while a request `Cookie:` header (which has no attributes, only pairs) is
  //      satisfied by ANY pair, so that `Cookie: theme=dark; session=<real>` still
  //      goes. Splitting on that difference is why the two forms are two entries
  //      sharing one id, in the `env_assignment` precedent: an id is a REASON.
  //
  // The value test is the one `bearer` already uses (a digit or base64 `=` padding, or
  // mixed case), widened by `_` and `%` because cookie values carry both and `ml_at_…`
  // is the shape this product itself issues. Diagram labels fail it as prose does:
  // `EXPIRED` is one case, `ml_at_xxx` is one case, `T` is neither long nor mixed. It
  // also refuses `[REDACTED]`, so when `jwt` or `provider_token` has already taken the
  // value this rule declines the leftovers rather than eating the header name; the
  // document is still refused, because the rule that took the value reported it.
  //
  // `Set-Cookie` contains `Cookie:`, so the request form carries `(?<![Tt]-)`. Without
  // it, every Set-Cookie line the first entry just rejected would be re-matched by the
  // second, which scans the whole line and would read an ATTRIBUTE as a value.
  //
  // `[ \t]*` replaces `\s*` because `\s` crosses newlines: `Cookie:\nsession=abc123`
  // used to redact the first line of the next paragraph as the header's value.
  [
    "cookie",
    /[Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee]:[ \t]*(?=[A-Za-z0-9_.\-]+=(?:(?=[A-Za-z_.\-+/~%]*[0-9=])|(?=[a-z0-9_.\-+/=~%]*[A-Z])(?=[A-Z0-9_.\-+/=~%]*[a-z]))[A-Za-z0-9_.\-+/=~%])[^\r\n]+/g,
    REDACTED,
  ],
  // The request form: no attributes, so ANY pair in the line qualifies. See
  // COOKIE_GRAMMAR above for why this is a separate entry under the same id.
  [
    "cookie",
    /(?<![Tt]-)[Cc][Oo][Oo][Kk][Ii][Ee]:[ \t]*(?=[^\r\n]*?[A-Za-z0-9_.\-]+=(?:(?=[A-Za-z_.\-+/~%]*[0-9=])|(?=[a-z0-9_.\-+/=~%]*[A-Z])(?=[A-Z0-9_.\-+/=~%]*[a-z]))[A-Za-z0-9_.\-+/=~%])[^\r\n]+/g,
    REDACTED,
  ],
  [
    "pem_key",
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    REDACTED,
  ],
];

const ENTROPY_TOKEN = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;

/**
 * Which entropy bar the generic heuristic applies. The LITERAL patterns above
 * are identical under both; only the last-resort heuristic moves.
 *
 * - "full" (default, and what every at-rest surface uses): 2+ character
 *   classes, entropy >= 3.5. Over-redaction is cheap when the destination is a
 *   database row an operator will read later.
 *
 * - "retrieval": 3+ character classes, entropy >= 4.0. For text that is itself
 *   a RETRIEVAL KEY on its way out to intel, where a "[REDACTED]" token is not
 *   a redaction but a destroyed query. Measured over a 30-question corpus
 *   (packages/cli/test/lib/redaction-fidelity.spec.ts): the "full" bar damages
 *   12 of 20 realistic developer questions, the retrieval bar 1 of 20, while
 *   still catching every secret in that corpus.
 *
 * - "events": the SAME literal patterns and the SAME entropy bar as "full",
 *   plus the narrow path-shape exemption below. Its only production caller is
 *   `mla _internal redact-events` on the CLI plane; it is mirrored here so this
 *   file stays a literal mirror of packages/cli/src/lib/redactor.ts and the
 *   parity fixture can compare the two byte-for-byte.
 */
const ENTROPY_BARS = {
  full: { minClasses: 2, minEntropy: 3.5 },
  retrieval: { minClasses: 3, minEntropy: 4.0 },
  // Deliberately identical to "full". The whole difference between the two
  // profiles is the path exemption below.
  events: { minClasses: 2, minEntropy: 3.5 },
};

/**
 * PATH_LIKE_EXEMPTION: contains a slash, contains a lowercase letter, contains
 * NO uppercase letter. Applied under "events" and "retrieval", NEVER under
 * "full". Widened to "retrieval" on 2026-07-28 with the OR-1 URL fix: a path
 * carrying DIGITS (every date-prefixed note slug, every timestamped migration
 * name) clears the 3-class retrieval bar on the digits alone, so the profile
 * named "retrieval" was destroying the exact identifiers it exists to preserve.
 * Full rationale in packages/cli/src/lib/redactor.ts.
 *
 * The "full" bar alters 64% of the captured bash-command items in the real
 * corpus and eats 8,909 path-shaped spans, while only 2.3% of those items
 * contain any credential pattern, which leaves the review ledger unable to say
 * which file a command touched. The no-uppercase clause keeps the exemption
 * away from base64, which is the shape of an AWS secret access key.
 *
 * ACCEPTED RESIDUAL, stated rather than argued away: a lowercase-and-digit
 * secret containing a slash matches this shape and passes. "Path-shaped" is a
 * signature, not a proof of innocence.
 */
function looksPathLike(token) {
  return token.includes("/") && /[a-z]/.test(token) && !/[A-Z]/.test(token);
}

function shannonEntropy(s) {
  if (!s) return 0;
  const counts = Object.create(null);
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  const n = s.length;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token, profile) {
  if (token.length < 32) return false;
  if ((profile === "events" || profile === "retrieval") && looksPathLike(token)) return false;
  let lower = false,
    upper = false,
    digit = false,
    sep = false;
  for (const ch of token) {
    if (ch >= "a" && ch <= "z") lower = true;
    else if (ch >= "A" && ch <= "Z") upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else if ("_-+/=".includes(ch)) sep = true;
  }
  // The ONE deliberate difference from the typed planes: an unknown profile
  // name falls back to the STRICTER bar instead of throwing. The TS planes get
  // this for free from `profile: RedactProfile`; a JS caller has no such
  // guard, and a typo must never silently disable redaction.
  const bar = ENTROPY_BARS[profile] ?? ENTROPY_BARS.full;
  const classes = [lower, upper, digit, sep].filter(Boolean).length;
  if (classes < bar.minClasses) return false;
  return shannonEntropy(token) >= bar.minEntropy;
}

/**
 * URL_STRUCTURE (OR-1). MIRROR of packages/cli/src/lib/redactor.ts; the full
 * rationale and the accepted residual live there. In short: ENTROPY_TOKEN's
 * charset excludes "." and ":", so it never matches a URL as a URL, the match
 * begins at the hostname's last dot and the replacement lands mid-hostname
 * ("https://meetless.atlassian.[REDACTED]"). Under "retrieval" ONLY, measure a
 * URL by the parts it is actually built from. The bar does not move; the
 * granularity does. An opaque component still clears the bar alone and still
 * dies, and the literal patterns still run first over the whole text.
 *
 * control and intel are deliberately profile-less planes and cannot be asked
 * for "retrieval" at all, so this lives only on the two planes that can.
 */
const URL_SPAN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const URL_PART_SPLIT = /([/?&=#;:@]+)/;

function redactUrlByParts(url, profile) {
  return url
    .split(URL_PART_SPLIT)
    .map((part) => (looksHighEntropy(part, profile) ? REDACTED : part))
    .join("");
}

function redactEntropy(text, profile) {
  const sweep = (s) => s.replace(ENTROPY_TOKEN, (m) => (looksHighEntropy(m, profile) ? REDACTED : m));
  if (profile !== "retrieval") return sweep(text);
  let out = "";
  let last = 0;
  URL_SPAN.lastIndex = 0;
  for (let m = URL_SPAN.exec(text); m !== null; m = URL_SPAN.exec(text)) {
    out += sweep(text.slice(last, m.index)) + redactUrlByParts(m[0], profile);
    last = m.index + m[0].length;
  }
  return out + sweep(text.slice(last));
}

/**
 * @param {string|null|undefined} text
 * @param {"full"|"retrieval"|"events"} [profile]
 * @returns {string|null|undefined}
 */
export function redact(text, profile = "full") {
  if (text === null || text === undefined || text === "") return text;
  let out = text;
  for (const [, pat, replacement] of PATTERNS) out = out.replace(pat, replacement);
  out = redactEntropy(out, profile);
  return out;
}
