import { classifyProbeFailure } from "../../src/commands/login";
import { HttpError } from "../../src/lib/http";

// Regression lock for the "`mla login` didn't open the browser" report.
//
// `mla login`'s no-op short-circuit probes control (GET /internal/v1/auth/me)
// before declaring "already logged in". The bug: a transient refresh failure
// surfaces as a RefreshBusyError with NO HTTP status, and the old classifier
// lumped it into the "offline -> keep cached session, no browser" branch. So a
// sibling mla process holding the refresh lock (or the server's dead-session 429,
// or a transient 5xx on the refresh POST) would make `mla login` print
// "already logged in (could not verify)" and exit WITHOUT opening a browser.
//
// classifyProbeFailure must route every one of those transient/contended signals
// to "reauth" (open the browser) and reserve "keep" for genuinely-unreachable
// control.

function err(fields: Partial<HttpError> & { name?: string }): HttpError {
  const e = new Error(fields.message ?? "probe failed") as HttpError;
  if (fields.name) e.name = fields.name;
  if (typeof fields.status === "number") e.status = fields.status;
  return e;
}

describe("classifyProbeFailure", () => {
  it("routes a server-side rejection (401/403) to reauth", () => {
    expect(classifyProbeFailure(err({ status: 401 }))).toBe("reauth");
    expect(classifyProbeFailure(err({ status: 403 }))).toBe("reauth");
  });

  it("routes a RefreshBusyError (no status) to reauth, not keep", () => {
    // THE bug: refresh-lock contention / 429 / transient 5xx all funnel into this.
    expect(
      classifyProbeFailure(err({ name: "RefreshBusyError" })),
    ).toBe("reauth");
  });

  it("keeps the cached session on a concrete non-auth HTTP status", () => {
    // Control reachable but erroring (e.g. 500 on /auth/me): an OAuth exchange
    // would hit the same broken control, so don't force a browser flow.
    expect(classifyProbeFailure(err({ status: 500 }))).toBe("keep");
    expect(classifyProbeFailure(err({ status: 404 }))).toBe("keep");
  });

  it("keeps the cached session on a genuine offline error (no status, no name)", () => {
    // fetch network failure: never reached control.
    expect(classifyProbeFailure(err({ message: "fetch failed" }))).toBe("keep");
    const abort = new Error("The operation was aborted") as HttpError;
    abort.name = "AbortError";
    expect(classifyProbeFailure(abort)).toBe("keep");
  });
});
