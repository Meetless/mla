// Shared secret redactor for the mla CLI. Mirror of
// intel/app/observability/redaction.py, apps/control/src/core/services/redactor.ts
// and meetless-cli/packages/ask-core/redactor.js (the ESM plane, which exists
// because this file is CommonJS and cannot be imported by an ESM-only package).
// Principle 7 of notes/20260528-mla-logging-and-tracing-proposal.md:
// exactly one redactor, applied at the three places an operator can see
// captured content. Cross-plane parity is locked by a shared fixture test
// (packages/cli/test/lib/redactor-parity.spec.ts and its three mirrors).

export const REDACTED = "[REDACTED]";

// Order matters: env_assignment runs first so KEY=value pairs are handled
// before the token literals, which come second for cases without an = sign.
// High-entropy heuristic runs last to catch generic session tokens that the
// prefix matchers miss.
//
// Third element is the REPLACEMENT. Every pattern replaces its whole match with
// the marker except env_assignment, which keeps the variable NAME and the
// separator and replaces only the value (groups: 1 name, 2 separator, 3 value).
const PATTERNS: Array<[string, RegExp, string]> = [
  // env_assignment is TWO entries sharing one rule id, because "an env var holding a
  // credential" and "a credential-named field in any casing" are different claims and
  // only the second one can be made safely case-insensitively.
  //
  // A (this entry) is the env-var claim, and it is case-SENSITIVE ON PURPOSE. Every
  // alternative below is written in SCREAMING_SNAKE, which IS the signal that this is
  // an environment variable rather than an ordinary program identifier. The rule used
  // to carry `/i`, which deleted that signal: `[A-Z][A-Z0-9_]*` then matched
  // `scope_key`, and the rule quietly became "any identifier ending in key, token,
  // secret or password". Measured on the 2094-note vault, the flag took the rule from
  // 46 notes to 140, and what it added was domain vocabulary, not credentials:
  // `scope_key` (162 hits), `run_key` (29), `idempotency_key` (25), `issue_key` (15),
  // `jira_key` (15), `inflight_token` (12), `partition_key`, `cache_key`, `dedupe_key`.
  // Under `block_on_detect` egress each is a REFUSED NOTE, so one flag character made
  // 94 notes ungovernable. This is the same trap that broke `bearer` below; a character
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
  // The value side carries the "a REFERENCE is not a VALUE" guard, shared with B
  // below and spelled out once at REFERENCE_GUARD.
  [
    "env_assignment",
    /\b(?!(?![A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|PASSWORD|PASSWD|PWD|PASSPHRASE)[^\S\r\n]*[:=])[A-Za-z0-9_.-]*[^\S\r\n]*[:=][^\S\r\n]*(?:'[A-Za-z]{1,12}'|"[A-Za-z]{1,12}"|[A-Za-z]{1,12})(?=[\s,;)\]}`'"]|$))((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)([^\S\r\n]*[:=][^\S\r\n]*)((?!['"]?(?:\$[({A-Za-z_]|\{\{|<|\[REDACTED\]))(?!['"]?[A-Za-z0-9_\-+/=]*\.\.\.['"]?(?=[\s,;)\]}`'"]|$))(?!['"]?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|token|key|secret|password|pwd)['"]?(?=[\s,;)\]}`'"]|$))(?=[^\s]*[A-Za-z0-9])(?:'[^']*'|"[^"]*"|\S+))/gm,
    // Keep the name. It is not a credential, and it is usually the primary
    // retrieval key: "OPENAI_API_KEY=[REDACTED]" still answers "which key was
    // set?", while a bare "[REDACTED]" answers nothing and makes the whole line
    // unsearchable. An earlier version replaced the entire match, so a redacted
    // command lost the one word that made it findable.
    //
    // Residual, stated plainly: the entropy sweep runs after this one and does
    // not know the name was deliberately preserved, so a name of 32+ chars
    // (uppercase + underscore clears the 2-class "full" bar) can still be eaten
    // under "full". That is the same over-redaction "full" already applies to
    // any long SCREAMING_SNAKE identifier, it is never worse than the previous
    // whole-match behaviour, and "retrieval" (3 classes) keeps such names.
    `$1$2${REDACTED}`,
  ],
  // B: the same id, for a credential-named field in ANY casing. Dropping `/i` from A
  // would also drop `api_key` (31 hits), `password` (8), `client_secret`,
  // `openai_api_key`, `aws_secret_access_key`, `private_key`: all real credentials,
  // all routinely lowercase in YAML, JSON, Python and shell. So the case-insensitive
  // half survives, but it has to EARN it: the noise was concentrated entirely in the
  // GENERIC suffix, where `key` means "identifier" (`scope_key`, `issue_key`). Here the
  // name must say credential in WORDS. A bare `_key` or `_token` suffix is not enough.
  //
  // This entry deliberately carries NO uppercase character class and NO lookahead over
  // one, so the `/i` trap that broke A and `bearer` cannot structurally apply to it.
  //
  // The value side needs its own guard, because a credential word appears in code as
  // often as in config: `accessToken: string;` is a type annotation. Unguarded, B fires
  // on `string;` (32 hits), `...` (11), `str,` (7), `Optional[str]`,
  // `os.getenv("OPENAI_API_KEY")`. The guard is SHAPE, not a dictionary of type names,
  // because a dictionary is a thing an author can talk their way past:
  //
  //   the value must contain at least one alphanumeric, AND
  //   a BARE (unquoted) value must be literal-shaped end to end.
  //
  // A quoted value is a literal by construction and needs no shape test. A bare value
  // that runs into `;` `,` `)` `[` `(` `{` `$` or a backtick is code, and code is not a
  // credential. Net over the vault: A+B refuse 59 notes where the single `/gim` rule
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
 *   a redaction but a destroyed query.
 *
 * The retrieval bar is not a guess. Measured over a 30-question corpus
 * (test/lib/redaction-fidelity.spec.ts), the "full" bar damages 12 of 20
 * realistic developer questions: deep file paths, import specifiers, stack
 * frames, URLs, branch names, 40-char git SHAs, 32-hex trace ids and
 * SCREAMING_SNAKE identifiers all clear a 2-class/3.5 bar. Raising to
 * 3 classes and 4.0 takes that to 1 of 20 while still catching every secret in
 * the corpus, including the bare ones no literal pattern covers (an
 * unprefixed AWS secret access key, a bare base64 blob).
 *
 * The residual cost, stated plainly: a PURE-HEX secret (2 classes) escapes the
 * retrieval bar. It is shape-identical to a git SHA, so no threshold separates
 * them. Such a token is still redacted at rest under "full", so it never
 * persists; the exposure is the in-flight question to our own intel service.
 *
 * - "events": the SAME literal patterns and the SAME entropy bar as "full"
 *   (2 classes, 3.5), plus one narrow exemption for path-shaped tokens. Exactly
 *   one production caller: `mla _internal redact-events`, the flush-time
 *   boundary for the hook event spool. See PATH_LIKE_EXEMPTION below for why it
 *   is a separate profile rather than a loosening of "full".
 */
export type RedactProfile = "full" | "retrieval" | "events";

const ENTROPY_BARS: Record<RedactProfile, { minClasses: number; minEntropy: number }> = {
  full: { minClasses: 2, minEntropy: 3.5 },
  retrieval: { minClasses: 3, minEntropy: 4.0 },
  // Deliberately identical to "full". The whole difference between the two
  // profiles is the path exemption below; if these ever diverge, "events" has
  // become a second retrieval bar and the reason for its existence is gone.
  events: { minClasses: 2, minEntropy: 3.5 },
};

/**
 * PATH_LIKE_EXEMPTION: contains a slash, contains a lowercase letter, contains
 * NO uppercase letter. Applied under "events" and "retrieval", NEVER under
 * "full" (see the call site for why it widened to "retrieval").
 *
 * Why it exists. Measured over a real captured corpus of 40 session transcripts
 * (scripts/measure-redaction-corpus.js, frozen into
 * test/fixtures/redaction-path-corpus.json): the "full" bar alters 64% of
 * captured bash-command items and eats 8,909 path-shaped spans across 1,575
 * distinct paths, while only 2.3% of those items contain any credential pattern
 * at all. The events spool is the ledger `mla review` reasons over, so a
 * redacted path is not a smaller answer, it is a wrong one: the review cannot
 * tell you which file a command touched. Under "events" all 8,909 survive and
 * the non-path-shaped spans are eaten identically (13,572 either way), which is
 * the measurement that says this exemption moved the path shape and nothing
 * else.
 *
 * Why the no-uppercase clause. A bare "contains a slash" exemption would collide
 * head-on with base64, and base64 is the shape of an AWS secret access key and
 * of most opaque session tokens. Requiring the token to be lowercase-only takes
 * the exemption away from every mixed-case blob.
 *
 * What this is NOT. "Path-shaped" is a SIGNATURE, not a proof of innocence. A
 * lowercase-and-digit secret containing a slash matches it and passes. That is
 * an ACCEPTED RESIDUAL, pinned by a test rather than argued away, and the
 * arithmetic about how rarely a random base64 generator lands in this shape is
 * a statement about generators, not a security property.
 *
 * Why a third profile instead of relaxing "full". "full" is the at-rest default,
 * the block-on-detect scanner's bar, and the fallback for an unrecognized
 * profile name. Loosening it would loosen all three at once, silently, for
 * callers that never asked.
 */
function looksPathLike(token: string): boolean {
  return token.includes("/") && /[a-z]/.test(token) && !/[A-Z]/.test(token);
}

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  const n = s.length;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token: string, profile: RedactProfile): boolean {
  if (token.length < 32) return false;
  // Applied under "events" AND "retrieval"; never under "full". Widened from
  // events-only on 2026-07-28 with the OR-1 URL fix, because the measurement
  // said the two profiles were blind in opposite directions and "retrieval" was
  // the one failing at its own job:
  //
  //   apps/console/app/settings/SettingsNav.tsx   KEPT retrieval / LOST events
  //   notes/20260726-mla-redaction-fidelity-...md LOST retrieval / KEPT events
  //   .../migrations/20260714_add_account_id/...  LOST retrieval / KEPT events
  //
  // A path dies under "retrieval" when it carries DIGITS, because digits supply
  // the third character class the 3-class bar wants. That is every date-prefixed
  // note slug and every timestamped migration name: for a product whose retrieval
  // keys ARE "notes/2026MMDD-*", the profile named "retrieval" was destroying the
  // exact identifiers it exists to preserve. The /v1/ask egress rule justifies
  // the retrieval bar with "SettingsNav.tsx would leave as [REDACTED].tsx"; that
  // example survives only because it happens to contain no digits.
  //
  // The residual is the one already accepted for "events" and stated below: a
  // lowercase-and-digit secret containing a slash matches the shape and passes.
  // Its blast radius is unchanged in kind (never at rest under "full"; here the
  // exposure is the in-flight question to our own intel service) and it is pinned
  // by a test, not argued away.
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
  // Fall back to the STRICTER bar on an unrecognized profile name (governed
  // non-negotiable: "an absent, misspelled, or unrecognized profile falls back
  // to full"). ask-core carries this with a comment saying the TYPED planes get
  // it for free from `profile: RedactProfile`. They do not: types are erased at
  // runtime, so a bare `ENTROPY_BARS[profile]` returned undefined and this
  // function threw a TypeError instead of falling back. Not reachable from any
  // caller today (every profile here is a typed literal and nothing catches a
  // throw around redact()), which is precisely why it sat unnoticed. A contract
  // that only holds because no one currently tests it is not holding.
  const bar = ENTROPY_BARS[profile] ?? ENTROPY_BARS.full;
  const classes = [lower, upper, digit, sep].filter(Boolean).length;
  if (classes < bar.minClasses) return false;
  return shannonEntropy(token) >= bar.minEntropy;
}

/**
 * URL_STRUCTURE (OR-1): a URL is a STRUCTURE, not a token. Applied only under
 * "retrieval".
 *
 * The bug it fixes. ENTROPY_TOKEN's charset excludes "." and ":", so it never
 * matches a URL AS a URL. The match instead begins at the last dot of the
 * hostname and runs to the end, so the replacement lands MID-HOSTNAME:
 *
 *   https://meetless.atlassian.net/wiki/spaces/PDM/pages/1234567/Some-PRD-Title
 *   -> https://meetless.atlassian.[REDACTED]
 *
 * A URL survives only if that trailing span is under 32 chars or carries fewer
 * than 3 character classes. It dies when it carries digits AND is >= 32 chars
 * AND clears 4.0 bits, which is precisely the population of versioned API URLs,
 * Confluence pages with numeric ids, object-store URLs and date-prefixed note
 * paths. That is the population most likely to BE the subject of a grounded
 * question, so under the one profile whose entire purpose is "this text is the
 * retrieval key" we were destroying the retrieval key. Content-dependent, too:
 * two Confluence URLs, one survives and one does not, on character diversity
 * alone. Nobody can predict it and nothing tells the user.
 *
 * The fix does NOT move the bar. Same 3 classes, same 4.0 bits. It changes the
 * GRANULARITY the bar is applied at: a URL is split on the separators it is
 * actually built from and each component is measured on its own. The example
 * above becomes "meetless.atlassian.net" + "wiki" + "spaces" + "PDM" + "pages"
 * + "1234567" + "Some-PRD-Title", none of which clears 32 chars, so the whole
 * URL survives. A genuinely opaque component (a signed-URL signature, a session
 * blob in a query value) still clears the bar ALONE and still dies, which is the
 * property that makes this a granularity change and not an exemption.
 *
 * Ordering is load-bearing: the LITERAL patterns run first, over the whole text,
 * unchanged. A credential in a URL query string is caught there, by name, before
 * any of this runs. This only ever governs the last-resort heuristic.
 *
 * ACCEPTED RESIDUAL, pinned by a test rather than argued away: standard base64
 * includes "/", so a base64 secret sitting in a URL path can be chopped into
 * sub-32-char components and escape the retrieval bar. Same category as the
 * pure-hex residual above and bounded the same way: at rest, under "full",
 * nothing changes and the blob is still eaten whole; the exposure is the
 * in-flight question to our own intel service.
 */
const URL_SPAN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const URL_PART_SPLIT = /([/?&=#;:@]+)/;

function redactUrlByParts(url: string, profile: RedactProfile): string {
  // split() with a capturing group keeps the separators, so join("") is exactly
  // the input. Nothing is reconstructed, only measured in smaller pieces.
  return url
    .split(URL_PART_SPLIT)
    .map((part) => (looksHighEntropy(part, profile) ? REDACTED : part))
    .join("");
}

function redactEntropy(text: string, profile: RedactProfile): string {
  const sweep = (s: string): string =>
    s.replace(ENTROPY_TOKEN, (m) => (looksHighEntropy(m, profile) ? REDACTED : m));
  if (profile !== "retrieval") return sweep(text);

  // Walk URL spans and non-URL spans separately rather than substituting
  // placeholders: a sentinel a caller's own text could contain is a leak
  // waiting to happen, and there is no sentinel to collide with here.
  let out = "";
  let last = 0;
  URL_SPAN.lastIndex = 0;
  for (let m = URL_SPAN.exec(text); m !== null; m = URL_SPAN.exec(text)) {
    out += sweep(text.slice(last, m.index)) + redactUrlByParts(m[0], profile);
    last = m.index + m[0].length;
  }
  return out + sweep(text.slice(last));
}

export function redact(
  text: string | null | undefined,
  profile: RedactProfile = "full",
): string | null | undefined {
  if (text === null || text === undefined || text === "") return text;
  let out = text;
  for (const [, pat, replacement] of PATTERNS) out = out.replace(pat, replacement);
  out = redactEntropy(out, profile);
  return out;
}

// --- Block-on-detect secret scanner (SECRET-1) ---
//
// The agent-memory capture pipeline
// (notes/20260626-agent-memory-auto-capture-proposal.md) must BLOCK a file from
// leaving the machine when it contains a known high-risk secret, rather than
// silently redact-and-send. This reuses the parity-locked PATTERNS + entropy
// heuristic above for detection and adds directive-style secrets the
// substitution redactor does not carry.
//
// HONEST SCOPE (do not overstate to users): this blocks KNOWN secret PATTERNS
// locally; it is NOT a guarantee that "secrets cannot leave the machine." A
// novel or low-entropy credential can still pass. Returns the set of matched
// rule ids, sorted + de-duplicated; the matched secret text is NEVER returned,
// so a caller that logs findings cannot leak the secret. Empty array == clean.

// Directive-style secrets the substitution redactor intentionally omits (it
// substitutes; this one only blocks). requirepass/masterauth/masteruser are
// Redis/Sentinel config directives: a lowercase keyword + space + value, which
// the uppercase env_assignment pattern and the 32-char entropy gate both miss
// (e.g. an 8-char `requirepass <value>` slips past both).
//
// This rule stays DELIBERATELY permissive, and that is a measured decision, not
// an oversight. Across the real 2094-note vault it fires on two prose lines in
// two notes and is the sole blocker on one of them, so the whole prize for
// tightening it is one document. Meanwhile all three candidate shape claims are
// dead: `requirepass wired` (prose) and `masteruser admin` (a real directive)
// are the same value shape at the same length; the live-corpus catch sits
// mid-sentence after a word, exactly where the prose does, so position cannot
// separate them; and that same fixture has prose after its value, so an
// end-of-directive anchor drops it. A false positive costs one refused document.
// A false negative is a live Redis password leaving the machine. The full
// argument, with the tie-breaks executable, is pinned in
// test/lib/redactor-redis-directive.spec.ts.
const BLOCK_DIRECTIVE_PATTERNS: Array<[string, RegExp]> = [
  ["redis_directive", /\b(requirepass|masterauth|masteruser)\s+('[^']*'|"[^"]*"|\S+)/gi],
];

// A pure-hex token (git SHA, content hash, digest) is not a secret, and the
// agent-memory corpus is dense with them. Excluding hex from the entropy block
// keeps the dry-run from blocking nearly every file on an incidental 40-char
// hash while still catching base64/mixed-class credential blobs.
function isHexToken(token: string): boolean {
  return /^[0-9a-f]+$/i.test(token);
}

// Bump when the block-on-detect pattern set or entropy heuristic changes. The
// capture ledger stores this alongside a blocked file so a policy upgrade
// re-evaluates content blocked under an older version (RETRY-2 for blocks).
// 2026-07-26.1 added the `jwt` pattern, so content blocked (or passed) under
// 2026-06-27.1 deserves re-evaluation.
export const SECRET_SCANNER_VERSION = "2026-07-26.1";

export function scanForSecrets(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const [name, pat] of PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  for (const [name, pat] of BLOCK_DIRECTIVE_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  ENTROPY_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTROPY_TOKEN.exec(text)) !== null) {
    const tok = m[0];
    // The block-on-detect scanner always uses the "full" bar: it gates a FILE
    // leaving the machine, where a false positive costs one blocked upload and
    // a false negative costs a live credential. It never uses "events": the
    // path exemption exists to protect a ledger's READABILITY, and this scanner
    // is not deciding readability, it is deciding whether a secret ships.
    if (!isHexToken(tok) && looksHighEntropy(tok, "full")) {
      hits.add("high_entropy_token");
      break;
    }
  }
  return [...hits].sort();
}

// --- Pre-upload credential denylist (Phase 2A/2B, proposal §4/§6) ---
//
// The LIVE capture path (Phase 2A+) must withhold a file from upload when it
// carries a KNOWN, high-confidence credential FORMAT, because the real corpus
// contains a live credential (SECRET-1). This is DELIBERATELY NOT scanForSecrets:
// it excludes the generic Shannon-entropy heuristic, which over-blocked 99.2% of
// the corpus in the Phase 0A static audit and is explicitly rejected for the
// blocking path. It runs ONLY the precision-first format matchers: provider-token
// prefixes (sk-/ghp_/AKIA/...), Authorization headers (Bearer/Basic), cookies,
// PEM private-key blocks, the Redis `requirepass`/`masterauth`/`masteruser`
// directives, and credential-named env assignments.
//
// HONEST SCOPE (do not overstate to users): a clean result means "none of these
// known formats are present," NOT "no secret exists." A novel or unformatted
// credential can still pass; that is an accepted, documented limit (§4 SECRET-1).
// Returns the matched rule ids, sorted + de-duplicated; the secret text is NEVER
// returned. Empty array == clean (eligible for upload). Reuses the parity-safe
// PATTERNS + BLOCK_DIRECTIVE_PATTERNS so the block formats stay in lockstep with
// the observe-only scanner, minus entropy.
// DERIVED, never hand-maintained. A hand-written copy of this list silently
// drifted once already: adding the `jwt` pattern made scanForCredentials able to
// return a rule id that the advertised universe did not contain, so any consumer
// treating this as "every reason a file can be blocked" would have been wrong
// and nothing failed. Deriving it makes that class of drift impossible; the
// spec pins the expected literal contents, so a NEW pattern still has to be
// acknowledged deliberately.
// De-duplicated because a rule id is a REASON, not a pattern: `env_assignment` is two
// table entries (SCREAMING_SNAKE env vars, and credential-named fields in any casing)
// that a caller has no reason to tell apart. Both scanners below already collapse them
// through a Set; without this one the advertised universe would list the id twice.
export const CREDENTIAL_RULE_IDS: readonly string[] = [
  ...new Set([
    ...PATTERNS.map(([name]) => name),
    ...BLOCK_DIRECTIVE_PATTERNS.map(([name]) => name),
  ]),
];

export function scanForCredentials(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const [name, pat] of PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  for (const [name, pat] of BLOCK_DIRECTIVE_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  return [...hits].sort();
}

/**
 * Structure-aware redaction: walk any JSON value and redact every string leaf,
 * leaving numbers, booleans, nulls and the object shape itself untouched.
 *
 * This is the sanitizer the egress registry reuses for a "redact" field, and it
 * is deliberately blind below the top level: it does not know or care what the
 * keys mean, so a newly nested string cannot escape by being somewhere the
 * policy did not anticipate.
 */
export function redactPayloadWithProfile<T>(value: T, profile: RedactProfile): T {
  if (typeof value === "string") return redact(value, profile) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => redactPayloadWithProfile(v, profile)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayloadWithProfile(v, profile);
    }
    return out as unknown as T;
  }
  return value;
}

/** The at-rest default. Kept as the name every existing caller already uses. */
export function redactPayload<T>(value: T): T {
  return redactPayloadWithProfile(value, "full");
}
