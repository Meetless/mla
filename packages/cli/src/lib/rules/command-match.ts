// COMMAND matcher: the pure tokenizer + classifier for the git/prisma rule class
// (GAP2).
//
// The proposal declares Bash PATH enforcement out of v1 (§552-556 / §3167) because
// a shell string is opaque: cp/mv/python/redirection/eval can perform an effect
// without the literal tokens appearing, so you can never prove a command is SAFE
// for a path rule. This module covers the decidable HALF the proposal left out:
// the POSITIVE literal match. If the forbidden tokens (e.g. "git push") appear as
// a contiguous run of unquoted, uncommented words, the command performs that
// operation. Opacity can only ADD effects, never remove the literal one, so a
// positive match is a sound VIOLATION.
//
// The asymmetry is deliberate and is the whole reason this matcher exists:
//   forbidden token run present   -> MATCHES_FORBIDDEN -> VIOLATION
//   no run found                  -> NO_MATCH          -> UNKNOWN (NOT compliant)
//   non-string / no usable needle -> INDETERMINATE     -> UNKNOWN
// There is NO command COMPLIANT. A non-match cannot prove the command will not push
// (an alias, a wrapper script, eval, or $VAR expansion could), so the absence of
// the run is UNKNOWN, never proof of compliance. That is the inverse of the CONTENT
// matcher, whose field is fully observable and so CAN produce a real COMPLIANT.
//
// Soundness of a positive match rests on three tokenizer guarantees:
//  1. quotes collapse a run into ONE token, so `echo "git push"` is not a match;
//  2. a `#` at a word boundary starts a comment, so `ls # git push` is not a match;
//  3. statement separators (newline, ; | &, parens) break a segment, so `git ;
//     push` is two statements, not the `git push` invocation.
// Known, ACCEPTED limitation: a command reached indirectly (an absolute path like
// `/usr/bin/git push`, a subshell `(git push)` with no inner spaces, an alias) will
// MISS. A miss is a false negative that degrades to UNKNOWN, which is the safe,
// non-denying state. This matcher is OBSERVE-ONLY in this slice; it must never deny
// until a tokenized pattern is human-attested, which is the safety valve for the
// residual risk that a contrived redirect target places the tokens consecutively.

/** A tokenized simple command: the words of one statement, in order. */
export type CommandSegment = string[];

// The version triple for the COMMAND compliance family, mirroring the note-vault
// constants in notes-path.ts. `bundle-enforce` gates on an EXACT match of all
// three before it enforces, so a payload minted against different semantics is
// not enforced rather than enforced under the wrong ones. Bump the evaluator
// contract whenever the verdict for a fixed (command, config) pair could change;
// bump the matcher schema whenever the config SHAPE changes.
// v1 -> v2 (2026-08-07, hours after v1 was minted). The tokenizer read HEREDOC
// BODIES as code, so a `git commit -F - <<EOF` whose message quoted an invocation
// matched as though it had performed it. That changes the verdict for a fixed
// (command, config) pair, which is exactly the condition this constant exists to
// mark: a v1-attested payload is no longer enforced by a v2 evaluator, and has to
// be re-attested by a human under the new semantics rather than silently
// reinterpreted. The bump is the mechanism working, not a mistake being papered
// over -- and the direction is safe either way, since v2 only ever matches LESS.
export const FORBIDDEN_COMMAND_EVALUATOR_CONTRACT_VERSION =
  "forbidden-command-allof-evaluator-v2";
export const FORBIDDEN_COMMAND_MATCHER_SCHEMA_VERSION = "forbidden-command-allof-v1";
/** This family judges a command string and canonicalizes no path. The field is
 * required by ComplianceEvaluatorSpec, so it carries an explicit sentinel rather
 * than borrowing a path canonicalizer's version, which would imply a path
 * algorithm participated in a verdict that never touched one. */
export const FORBIDDEN_COMMAND_CANONICALIZER_VERSION = "no-path-canonicalization-v1";

/**
 * The three observable states of a command string against a forbidden token-run
 * set. Pure: no I/O. NO_MATCH and INDETERMINATE both degrade to UNKNOWN; only
 * MATCHES_FORBIDDEN is a verdict, and only a positive one.
 */
export type CommandClassification = "MATCHES_FORBIDDEN" | "NO_MATCH" | "INDETERMINATE";

// Statement separators that break a token run. A forbidden sequence can never
// match ACROSS one of these, so two adjacent statements cannot be read as a single
// command invocation. Redirections (< >) are deliberately NOT here: they leave
// their operator as its own token, which already breaks contiguity.
const SEPARATORS = new Set([";", "|", "&", "(", ")", "\n"]);
const DQUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`", "\n"]);

/**
 * A deliberately small POSIX-ish tokenizer, scoped to what a SOUND positive match
 * needs: single quotes (literal), double quotes (with the POSIX backslash escapes),
 * backslash escaping and line continuation, `#` comments at a word boundary, and
 * the statement separators above. It does not expand variables, globs, aliases, or
 * substitutions: those only ever cause a MISS (UNKNOWN), never a false match.
 */
export function tokenizeCommand(raw: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let segment: CommandSegment = [];
  let token = "";
  let inToken = false;

  const endToken = (): void => {
    if (inToken) {
      segment.push(token);
      token = "";
      inToken = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  };

  let i = 0;
  while (i < raw.length) {
    const c = raw[i];

    // HEREDOCS. `<<WORD`, `<<'WORD'`, `<<"WORD"` and `<<-WORD` introduce inline
    // DATA, and so does the `<<<` here-string. The body is not code and must
    // yield no tokens.
    //
    // Missing this was a real false positive, not a theoretical one: the
    // comp-credit rule's FIRST live verdict fired on a `git commit -F - <<EOF`
    // whose message quoted the invocation it governs. The commit touched no
    // ledger. The header's soundness argument already depended on inline data
    // being opaque (`echo "git push"` is not a match); a heredoc is the same
    // construct in different syntax and was simply overlooked.
    //
    // This is the input shape that matters most, because governed rules quote
    // the commands they govern: notes, commit messages and rule text are exactly
    // where an invocation appears as prose. A rule that cries wolf there trains
    // the operator to scroll past the banner that works.
    if (c === "<" && raw[i + 1] === "<") {
      endToken();
      // `<<<` is a here-string: ONE word of data follows. Emit the operator so
      // the segment still records that a redirect happened, then drop the word.
      if (raw[i + 2] === "<") {
        segment.push("<<<");
        i += 3;
        while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
        while (i < raw.length && !" \t\r\n;|&()".includes(raw[i])) i++;
        continue;
      }
      let j = i + 2;
      const dash = raw[j] === "-";
      if (dash) j++;
      while (j < raw.length && (raw[j] === " " || raw[j] === "\t")) j++;
      // The delimiter word, with quoting stripped. Quoting only controls whether
      // the BODY is expanded; it never changes where the body ends, so both
      // forms terminate identically.
      let delim = "";
      while (j < raw.length && !" \t\r\n;|&()".includes(raw[j])) {
        const d = raw[j];
        if (d === "'" || d === '"') {
          j++;
          continue;
        }
        delim += d;
        j++;
      }
      if (delim.length === 0) {
        // `<<` with no delimiter is not a heredoc we can resolve. Emit it as an
        // operator token and carry on rather than guessing where a body ends.
        segment.push("<<");
        i += 2;
        continue;
      }
      segment.push(`<<${dash ? "-" : ""}${delim}`);
      // Skip to the end of THIS line, then consume body lines until one whose
      // trimmed content is exactly the delimiter. Trimmed because `<<-` strips
      // leading tabs from the terminator, and a stray trailing space is common.
      while (j < raw.length && raw[j] !== "\n") j++;
      if (j < raw.length) j++; // step past the newline that opens the body
      while (j < raw.length) {
        let lineEnd = raw.indexOf("\n", j);
        if (lineEnd < 0) lineEnd = raw.length;
        if (raw.slice(j, lineEnd).trim() === delim) {
          j = lineEnd;
          break;
        }
        j = lineEnd + 1;
      }
      // An unterminated heredoc runs to end of input. Consuming the rest can only
      // cause a MISS (UNKNOWN), never a false match, which is the safe direction.
      i = Math.min(j, raw.length);
      endSegment();
      continue;
    }

    if (c === "'") {
      inToken = true;
      i++;
      while (i < raw.length && raw[i] !== "'") {
        token += raw[i];
        i++;
      }
      i++; // consume the closing quote (or run off the end on an unbalanced quote)
      continue;
    }

    if (c === '"') {
      inToken = true;
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < raw.length && DQUOTE_ESCAPABLE.has(raw[i + 1])) {
          token += raw[i + 1];
          i += 2;
          continue;
        }
        token += raw[i];
        i++;
      }
      i++;
      continue;
    }

    if (c === "\\") {
      if (i + 1 < raw.length && raw[i + 1] === "\n") {
        i += 2; // line continuation: both chars vanish
        continue;
      }
      if (i + 1 < raw.length) {
        token += raw[i + 1];
        inToken = true;
        i += 2;
        continue;
      }
      token += c;
      inToken = true;
      i++;
      continue;
    }

    // A hash starts a comment only at a word boundary (not mid-token), matching
    // shell semantics: `abc#def` is one word, ` # ...` is a comment.
    if (c === "#" && !inToken) {
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      endToken();
      i++;
      continue;
    }

    if (SEPARATORS.has(c)) {
      endSegment();
      i++;
      continue;
    }

    token += c;
    inToken = true;
    i++;
  }

  endSegment();
  return segments;
}

/** True iff `needle` occurs as a contiguous run inside `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let all = true;
    for (let k = 0; k < needle.length; k++) {
      if (haystack[start + k] !== needle[k]) {
        all = false;
        break;
      }
    }
    if (all) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a candidate command string against a set of forbidden token sequences.
 *
 * INDETERMINATE when the value is not a string, or when no usable forbidden
 * sequence remains after dropping sequences that are empty or contain an empty
 * token (an empty token would degenerate matching). Otherwise MATCHES_FORBIDDEN
 * iff some forbidden sequence is a contiguous run within some statement segment;
 * NO_MATCH if none are. NO_MATCH is NOT compliance (see module header).
 */
export function classifyCommand(
  rawCommand: unknown,
  forbiddenSequences: readonly (readonly string[])[],
): CommandClassification {
  if (typeof rawCommand !== "string") {
    return "INDETERMINATE";
  }
  const needles = forbiddenSequences.filter(
    (seq) =>
      Array.isArray(seq) &&
      seq.length > 0 &&
      seq.every((t) => typeof t === "string" && t.length > 0),
  );
  if (needles.length === 0) {
    return "INDETERMINATE";
  }
  const segments = tokenizeCommand(rawCommand);
  for (const segment of segments) {
    for (const needle of needles) {
      if (containsRun(segment, needle)) {
        return "MATCHES_FORBIDDEN";
      }
    }
  }
  return "NO_MATCH";
}

/**
 * Does one command token satisfy one needle token?
 *
 * Exact equality, plus ONE narrow relaxation: a needle naming a bare filename
 * also matches a command token whose POSIX basename equals it. `comp-credit.cjs`
 * therefore matches `tools/billing/comp-credit.cjs`, `./comp-credit.cjs` and
 * `/Users/an/meetless/comp-credit.cjs`, which are the same script.
 *
 * Without this the rule could not fire at all: the real invocation is
 * `node tools/billing/comp-credit.cjs --apply`, so the token IS the path. Pinning
 * the full relative path instead would leave the same script, run from a different
 * cwd or by absolute path, walking straight past a rule its attester believes is
 * armed. That is a silent authority hole, and it is worse than a miss because the
 * operator does not know they lost the protection.
 *
 * TWO guards keep the relaxation from leaking, and both are pinned by tests:
 *   - a needle containing `/` is LOCATION, not identity, and keeps exact equality,
 *     so an author who wrote a path gets the path they attested;
 *   - a needle starting with `-` is a FLAG, not a filename, and keeps exact
 *     equality, so `--apply` can never be satisfied by a token like `x/--apply`.
 * Basename comparison is whole-segment, never substring, so `comp-credit.cjs.bak`
 * and `comp-credit-v2.cjs` are different files and do not match.
 */
function tokenSatisfies(token: string, needle: string): boolean {
  if (token === needle) return true;
  if (needle.includes("/") || needle.startsWith("-")) return false;
  const base = token.slice(token.lastIndexOf("/") + 1);
  return base === needle && token.includes("/");
}

/** True iff `needle` occurs as a contiguous run inside `haystack`, comparing token
 * by token through `tokenSatisfies` (exact, plus the documented basename rule). */
function containsRunByIdentity(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let all = true;
    for (let k = 0; k < needle.length; k++) {
      if (!tokenSatisfies(haystack[start + k], needle[k])) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** A sequence is usable iff it is a non-empty array of non-empty string tokens. An
 * empty token would degenerate matching, so it disqualifies the whole sequence. */
function isUsableSequence(seq: unknown): seq is readonly string[] {
  return (
    Array.isArray(seq) &&
    seq.length > 0 &&
    seq.every((t) => typeof t === "string" && t.length > 0)
  );
}

/**
 * Classify a command against a CONJUNCTION of required token runs: the command
 * matches only when EVERY sequence occurs, as a contiguous run, inside ONE
 * statement segment.
 *
 * WHY A SECOND CLASSIFIER AND NOT A LOOP OVER `classifyCommand`. Two reasons,
 * and the first is a soundness bug that a loop would silently ship:
 *
 *  1. SAME-SEGMENT. `classifyCommand` answers "does any segment contain this
 *     run". Called once per needle, `comp-credit.cjs --dry-run ; echo --apply`
 *     answers yes twice, from two different statements, and the conjunction
 *     would fire on a command that performs neither operation together. Segment
 *     identity is not expressible by composing the disjunctive form, so the
 *     tokenizer is walked once here and every needle is tested against the SAME
 *     segment.
 *  2. UNUSABLE NEEDLES INVERT. The disjunctive form FILTERS a malformed
 *     sequence out and proceeds, which is safe there: fewer alternatives can
 *     only ever make a disjunction harder to satisfy. In a conjunction dropping
 *     a needle REMOVES a condition, so a typo'd entry would broaden the rule
 *     instead of narrowing it. Any unusable sequence therefore makes the whole
 *     rule INDETERMINATE (-> UNKNOWN, never a warn), never a smaller conjunction.
 *
 * Soundness is otherwise inherited verbatim from `classifyCommand`: quotes,
 * comments and separators cannot be crossed, indirection only ever causes a MISS,
 * and there is still NO COMPLIANT outcome. A non-match is UNKNOWN, not proof the
 * command is safe.
 *
 * The operation this exists for is `comp-credit.cjs ... --apply`: dangerous only
 * when the script AND the mutating flag are both present, and never contiguous,
 * so no single forbidden run can express it and a disjunctive encoding would warn
 * on every `--apply` in the repository.
 */
export function classifyCommandAllOf(
  rawCommand: unknown,
  requiredSequences: readonly (readonly string[])[],
): CommandClassification {
  if (typeof rawCommand !== "string") {
    return "INDETERMINATE";
  }
  if (
    !Array.isArray(requiredSequences) ||
    requiredSequences.length === 0 ||
    !requiredSequences.every(isUsableSequence)
  ) {
    return "INDETERMINATE";
  }
  for (const segment of tokenizeCommand(rawCommand)) {
    if (requiredSequences.every((needle) => containsRunByIdentity(segment, needle))) {
      return "MATCHES_FORBIDDEN";
    }
  }
  return "NO_MATCH";
}
