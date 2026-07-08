import { KbCliConfig } from "./config";
import { get, HttpError } from "./http";

// KB curation §9.3 + §13.14 second bullet: every KB write command MUST refuse
// to run when the configured `actorUserId` is not a workspace OWNER. The
// doctor surfaces the same check up front so an operator can fix the config
// before invoking a write, but the doctor is advisory and an operator can
// (and does) skip running it. Without a runtime gate, a non-owner config
// would silently stamp an unauthorized identity onto an outbox event and the
// audit row would land as if the write were authorized. §9.5 leaves room for
// a future per-scope `KB_CURATE` permission; v1 is owner-only by design
// (proposal §11 locked decision Q8) and the gate lives here so all KB write
// commands share a single source of truth.
//
// Implementation parity with doctor.ts (§9.3):
//   - Same endpoint: GET /internal/v1/whoami?workspaceId=<ws>&actorUserId=<id>
//   - Same actorIsOwner resolution: trust the typed boolean when present,
//     fall back to actor.role === "OWNER" so a rollout that ships the CLI
//     before the new server field does not flap.
//   - Same fail-message shape: name the actor, the workspace, and point to
//     the doctor so the operator can re-verify after fixing the config.

const OWNER_CHECK_TIMEOUT_MS = 6000;
// The whoami probe is an idempotent GET, so a transient transport failure is
// safe to retry. Incident (session 2c881e60, 2026-06-14): the per-doc owner
// check inside `mla kb add` hit a single undici "fetch failed" connection blip
// right after a heavy ingest, threw with no retry, and the auto-index loop
// counted the produced doc `failed` with no in-run recovery -> the note was
// silently orphaned from the KB. A small bounded retry absorbs that blip for
// EVERY KB write command and the auto-index preflight without weakening the
// owner-only gate (a deterministic non-owner / 4xx verdict is never retried).
const OWNER_CHECK_MAX_ATTEMPTS = 3;
// Linear backoff between attempts. Index 0 is the wait after attempt 1, etc;
// the last entry is reused if maxAttempts is raised. Kept short: the common
// failure ("fetch failed" = connection refused/reset) rejects in milliseconds.
const OWNER_CHECK_BACKOFF_MS = [200, 500];

interface WhoamiResponseShape {
  actorIsOwner?: boolean;
  actor?: { role?: string; displayName?: string; email?: string };
  workspace?: { id?: string; slug?: string };
}

export interface OwnerCheckOpts {
  // Total attempts (1 = the original single-shot behavior). Defaults to 3.
  maxAttempts?: number;
  // Injectable backoff so tests drive the retry loop without real timers.
  sleep?: (ms: number) => Promise<void>;
}

export class KbOwnerCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbOwnerCheckError";
  }
}

function resolveActorIsOwner(body: WhoamiResponseShape | undefined): boolean {
  if (!body) return false;
  if (typeof body.actorIsOwner === "boolean") return body.actorIsOwner;
  return body.actor?.role === "OWNER";
}

// A request that never received an HTTP response (DNS, ECONNREFUSED,
// ECONNRESET, socket hang up, fetch abort/timeout) rejects as a raw
// TypeError/DOMException with NO `status` (see HttpError doc in http.ts). A 5xx
// is a server-side transient. Both are worth a bounded retry. A 4xx (incl. a
// 401 that already survived doFetch's auto-refresh) is a deterministic verdict
// that a retry cannot change.
function isTransientHttpError(err: HttpError): boolean {
  return err.status === undefined || err.status >= 500;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWhoamiWithRetry(
  cfg: KbCliConfig,
  path: string,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<WhoamiResponseShape> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await get<WhoamiResponseShape>(cfg, path, OWNER_CHECK_TIMEOUT_MS);
    } catch (e) {
      const err = e as HttpError;
      if (attempt >= maxAttempts || !isTransientHttpError(err)) {
        throw new KbOwnerCheckError(
          `KB owner check failed: could not reach control to verify actor ` +
            `'${cfg.actorUserId}' for workspace '${cfg.workspaceId}'. ` +
            `${err.message.slice(0, 200)}. ` +
            `Run 'mla doctor' to diagnose; KB curation requires OWNER.`,
        );
      }
      const backoff =
        OWNER_CHECK_BACKOFF_MS[Math.min(attempt - 1, OWNER_CHECK_BACKOFF_MS.length - 1)];
      await sleep(backoff);
    }
  }
}

export async function verifyKbActorIsOwner(
  cfg: KbCliConfig,
  opts: OwnerCheckOpts = {},
): Promise<void> {
  const path =
    `/internal/v1/whoami?workspaceId=${encodeURIComponent(cfg.workspaceId)}` +
    `&actorUserId=${encodeURIComponent(cfg.actorUserId)}`;

  const maxAttempts = opts.maxAttempts ?? OWNER_CHECK_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;

  const body = await fetchWhoamiWithRetry(cfg, path, maxAttempts, sleep);

  if (!body?.actor) {
    throw new KbOwnerCheckError(
      `KB owner check failed: actor '${cfg.actorUserId}' is not a member of ` +
        `workspace '${cfg.workspaceId}'. Edit cli-config.json to point at a ` +
        `workspace OWNER, then re-run 'mla doctor' to confirm.`,
    );
  }

  if (!resolveActorIsOwner(body)) {
    const role = body.actor?.role ?? "UNKNOWN";
    throw new KbOwnerCheckError(
      `KB owner check failed: actor '${cfg.actorUserId}' has role '${role}' ` +
        `in workspace '${cfg.workspaceId}'; KB curation requires OWNER ` +
        `(proposal §9.3 + §13.14). Re-point cli-config.actorUserId at a ` +
        `workspace owner and re-run 'mla doctor'.`,
    );
  }
}
