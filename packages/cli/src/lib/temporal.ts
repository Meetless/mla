// Shared temporal helpers for the MLA CLI's as-of surfaces (B9).
//
// `parseAsOf` normalizes an operator-supplied date into a UTC ISO-8601 instant
// (a VALID-time cutoff: "what was true as of this instant"). It is the front
// door for `mla ask --as-of`; the intel side reads it as `AskRequest.as_of` and
// runs the point-in-time filter. We reject anything malformed so a typo never
// silently answers as-of "now".
//
// Render helpers (renderValidWindow, renderTrustLabel) live here too so every
// as-of surface can format the bi-temporal window and the clock trust the same
// way. `kb show` was their first consumer, but relationship edges (and their
// valid-time windows) left the detail view for the Console relationships lane,
// so they currently have no CLI consumer; they are retained for future as-of
// render surfaces. The help surfaces (cli.ts USAGE + kb.ts KB_USAGE) still teach
// the same valid-time vs observation-time axes.
//
// Plan: notes/20260605-mla-full-temporal-awareness-implementation-plan.md, Tasks 5.1-5.4.

const DASHED = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

// Build a midnight-UTC ISO instant from year/month/day, rejecting rolled-over
// dates: JS `Date` silently turns 2026-02-30 into Mar 2, so we round-trip the
// components and refuse any that do not survive intact.
function isoFromYmd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.toISOString();
}

// Parse an `--as-of` argument into a UTC ISO-8601 instant. Accepts:
//   - `YYYY-MM-DD` and compact `YYYYMMDD` -> midnight UTC of that day
//   - a full ISO-8601 datetime (e.g. 2026-04-10T12:30:00Z) -> normalized instant
// Throws on anything else.
export function parseAsOf(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) {
    throw new Error("`--as-of` requires a date (YYYY-MM-DD or YYYYMMDD).");
  }

  const m = DASHED.exec(s) ?? COMPACT.exec(s);
  if (m) {
    const iso = isoFromYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!iso) {
      throw new Error(`Invalid --as-of date: '${raw}'. Use YYYY-MM-DD or YYYYMMDD.`);
    }
    return iso;
  }

  // Full ISO-8601 datetime: pin a precise instant. Date.parse is lenient, so we
  // require the string to at least carry a 'T' before trusting it as a datetime,
  // keeping bare junk ("not-a-date") on the reject path.
  if (s.includes("T")) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString();
    }
  }

  throw new Error(`Invalid --as-of date: '${raw}'. Use YYYY-MM-DD or YYYYMMDD.`);
}

// The clock sources Meetless trusts as VALID-time authority. Mirrors intel's
// TRUSTED_ASOF_SOURCES (app/graphs/ask/retrieval/asof.py): an explicit author
// stamp, a document date, a diff audit-log entry, or a source-event time.
// INGESTION_TIME_PROXY and UNKNOWN are observed-only, never validated.
const TRUSTED_TIME_SOURCES = new Set([
  "EXPLICIT_METADATA",
  "DOCUMENT_DATE",
  "DIFF_AUDIT_LOG",
  "SOURCE_EVENT_TIME",
]);

// Plain-words trust label for a relation's valid_time_source. Trusted sources
// read as "trusted"; anything observed-only reads as "approximate (observed,
// not validated)" so an operator never mistakes an ingestion guess for a
// validated clock. Two axes, two answers (B17): this is the trust of the
// VALID-time clock, separate from whether the edge survives an as-of filter.
export function renderTrustLabel(source: string | null | undefined): string {
  if (source && TRUSTED_TIME_SOURCES.has(source)) {
    return "trusted";
  }
  return "approximate (observed, not validated)";
}

// Reduce a stored ISO instant to its calendar date for a compact window line.
// Falls back to the raw value if it is not an ISO date so we never drop signal.
function calendarDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

// Render a bi-temporal VALID-time window in plain words. No double-dash range
// separators (An's AI-smell rule); the open end is spelled out so an operator
// reads "still in force" rather than guessing at a blank. Cases:
//   both bounds   -> "valid from <from> until <until>"
//   open-ended    -> "valid from <from> (open-ended)"
//   close-only    -> "valid until <until>" (rare; close recorded, open missing)
//   neither       -> "validity window not recorded"
export function renderValidWindow(window: {
  validAt?: string | null;
  invalidAt?: string | null;
}): string {
  const from = calendarDate(window.validAt);
  const until = calendarDate(window.invalidAt);
  if (from && until) return `valid from ${from} until ${until}`;
  if (from) return `valid from ${from} (open-ended)`;
  if (until) return `valid until ${until}`;
  return "validity window not recorded";
}
