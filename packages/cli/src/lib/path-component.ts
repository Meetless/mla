// Guard for identifiers that become FILESYSTEM PATH COMPONENTS.
//
// A workspaceId and a runId are not only lookup keys: every per-workspace artifact lives at
// `<state root>/workspaces/<workspaceId>/...` and every onboarding artifact at
// `.../onboarding-runs/<runId>.json`. `path.join` normalizes what it is handed, so an id
// shaped like `../../x` does not produce a badly-named directory, it produces a path OUTSIDE
// the state root. Verified before the fix: `writeScanCache(home, "../../escaped", ...)`
// created `<home>/escaped/scan-cache.json` and never created the state root at all.
//
// The ids reach us from places that never checked their shape: `.meetless.json` (activation.ts
// accepts any non-empty string), `MEETLESS_WORKSPACE_ID`, `--workspace`, and, for a runId, a
// parsed sidecar payload. The observed damage was quieter than traversal and worse to debug:
// on 2026-07-15 a shell-quoted id reached `join()` with its quotes attached and created
// `~/.meetless/workspaces/'cmexample0000000000000001'` NEXT TO the real
// `cmexample0000000000000001`, forking one workspace's state into two directories that could
// not see each other. Both are on disk today. (The id here is the synthetic placeholder, not
// the operator's actual one: this directory is the source of the PUBLIC mirror, and scrub
// gate 2 in tools/export-mla-public.sh refuses to export a real cuid.)
//
// The guard sits at the SINK (the path builders), not at the many sources, on the same
// reasoning as the scan-cache owner stamp (3ae06e39e) and the floor projection's foreign-root
// refusal: a rule enforced where the path is built cannot be bypassed by a caller that forgot.
//
// REJECT, never sanitize. Mapping unsafe characters onto a substitute (as the bash-mirroring
// `sanitizeWorkspaceId` in governance-cache.ts must, because a shell reader has to agree with
// it on a filename) would map two distinct ids onto ONE directory, which is a state-mixing bug
// strictly worse than a loud failure. An id outside this shape is a defect or an attack; there
// is no legitimate caller.

// Exactly one path component: no separator on any platform, no NUL, no whitespace, no quotes.
// Every real id on disk (cuids) and every id the suite uses (`ws_1`, `proj_9`, `a.b-c_d`) is
// inside this set, so the guard is invisible to correct callers.
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

// Generous, but bounded: a component longer than this is not an id, and it walks into
// ENAMETOOLONG territory where the failure surfaces far from its cause.
const MAX_COMPONENT_LENGTH = 128;

export class UnsafePathComponentError extends Error {
  constructor(
    readonly kind: string,
    readonly value: unknown,
  ) {
    super(
      `Refusing to build a state path from ${kind} ${JSON.stringify(value)}: it is not a ` +
        `single safe path component (allowed: letters, digits, '.', '_', '-'; not '.' or ` +
        `'..'; max ${MAX_COMPONENT_LENGTH} chars). This usually means a stale or hand-edited ` +
        `.meetless.json marker, or an id that picked up shell quoting. Re-run 'mla activate' ` +
        `to repair the binding.`,
    );
    this.name = "UnsafePathComponentError";
  }
}

/**
 * Return `value` when it is safe to use as one path component, else throw.
 * `kind` is the operator-facing noun ("workspace id", "run id") and appears in the message,
 * because a guard that says only "invalid" leaves an operator staring at a directory listing.
 */
export function assertSafePathComponent(kind: string, value: string): string {
  if (
    typeof value === "string" &&
    value.length <= MAX_COMPONENT_LENGTH &&
    SAFE_PATH_COMPONENT.test(value) &&
    value !== "." &&
    value !== ".."
  ) {
    return value;
  }
  throw new UnsafePathComponentError(kind, value);
}

export const assertSafeWorkspaceId = (workspaceId: string): string =>
  assertSafePathComponent("workspace id", workspaceId);

export const assertSafeRunId = (runId: string): string => assertSafePathComponent("run id", runId);
