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
