// Rendering untrusted repository text at the terminal.
//
// A finding row prints values this process did not author: the quoted sentence comes out of a
// document, the paths come out of git's name-status, the author name comes out of a commit
// header. Whoever can edit a doc or land a commit controls those bytes, and on a shared
// repository that is not the person reading the row. The row is therefore a rendering of DATA,
// and this is the function that keeps it that way: a value may change what a line SAYS, never
// what the terminal DOES, and never what the screen appears to be offering.
//
// What a raw value can otherwise do:
//   - ESC sequences repaint the screen, hide text, or recolor a warning into a success
//   - CR and BS overwrite the characters the operator already read
//   - LF forges layout: a quote can print its own "Answer it: mla enrich resolve --run-id ..."
//     line and point the next command at a run the attacker chose
//   - bidi overrides (trojan source) reverse the visual order of a path, so a rule scoped to
//     `src/evil` renders as `src/safe` and gets a real human signature under it
//
// This is a DISPLAY transform only. Nothing sanitized here is ever stored: the mint and the
// ancestry proof depend on the quote being byte-exact, so the sidecar keeps the original and
// only the screen gets this version.

// Appended when a value was cut. Visible on purpose: a row that silently shortened the sentence
// the human is being asked to sign off on would be misrepresenting the question.
export const TERMINAL_TRUNCATION_MARK = "...";

// An escape SEQUENCE is one unit, so it is removed whole. Dropping only the ESC byte would
// disarm the terminal but leave the attacker's payload ("[2J", "]0;title") printed as text,
// which is still their content sitting in our row.
// Order matters: OSC first (it contains a `]`), then CSI, then the short two-byte forms, which
// would otherwise eat the `[` that opens a CSI.
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// eslint-disable-next-line no-control-regex
const CSI_SEQUENCES = /[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const SHORT_ESCAPES = /\u001b[ -~]/g;

// Whatever control bytes remain: bare ESC, CR, LF, TAB, BS, DEL, C1. Replaced by a space rather
// than deleted, so a newline between two words does not silently fuse them into one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

// Zero-width and directional-formatting characters. Deleted rather than spaced: they occupy no
// column, so a space would be inventing whitespace that was never there.
//   200b-200f zero width space/non-joiner/joiner, LRM, RLM
//   202a-202e embeddings and overrides
//   2066-2069 isolates
//   feff      byte order mark used mid-string
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * One line of printable text, safe to concatenate into a terminal row.
 *
 * The cap is applied AFTER stripping, so a value cannot spend its budget on invisible bytes and
 * push the part that carries the meaning off the end of the row.
 */
export function terminalSafe(value: string, maxLen: number): string {
  const cleaned = value
    .replace(OSC_SEQUENCES, "")
    .replace(CSI_SEQUENCES, "")
    .replace(SHORT_ESCAPES, "")
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, Math.max(0, maxLen - TERMINAL_TRUNCATION_MARK.length)) + TERMINAL_TRUNCATION_MARK;
}
