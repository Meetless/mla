import {
  isWorkspaceAccessDenied,
  deniedWorkspaceId,
  workspaceAccessDeniedMessage,
  WORKSPACE_ACCESS_DENIED_CODE,
} from "../../src/lib/workspace-access";

// Behavioral lock for the ONE handler that turns a workspace-membership 403 into
// human text (BUG-5). The CLI used to render this failure five different ways,
// three of them wrong (a nonexistent "controlToken" to check, a false "login
// expired", a raw internal-URL dump). Every membership 403 now routes through
// these three functions, so this spec pins:
//   1. detection across BOTH server planes' envelope shapes,
//   2. the message is sourced from the server (never drifts from the source of
//      truth), and
//   3. the graceful fallbacks (unparseable body, non-403, socket error).
//
// The canonical line, emitted identically by control and intel:
const CANONICAL =
  "You are not a member of workspace 'ws_target'. Ask a workspace admin to add you to it.";

// Faithful reconstruction of lib/http.ts buildError: an HTTP non-2xx carries
// `.status` and the raw `.body`, and INLINES the body into `.message` (so a
// substring test holds whether a caller kept the HttpError or re-wrapped it).
function httpError(status: number, body: string): Error & { status: number; body: string } {
  const e = new Error(
    `GET https://control.example/internal/v1/rules -> HTTP ${status}: ${body.slice(0, 500)}`,
  ) as Error & { status: number; body: string };
  e.status = status;
  e.body = body;
  return e;
}

// control (apps/control api-exception.ts workspaceAccessDenied): code + message
// TOP-LEVEL, plus details.requestedWorkspaceId.
const controlBody = JSON.stringify({
  statusCode: 403,
  code: WORKSPACE_ACCESS_DENIED_CODE,
  message: CANONICAL,
  requestId: "req_1",
  details: { requestedWorkspaceId: "ws_target" },
});

// intel (app/core/auth.py): code + message NESTED under `detail`, no
// requestedWorkspaceId (the id lives inside the message string).
const intelBody = JSON.stringify({
  detail: { code: WORKSPACE_ACCESS_DENIED_CODE, message: CANONICAL },
});

describe("isWorkspaceAccessDenied", () => {
  it("detects a control-plane denial (top-level code)", () => {
    expect(isWorkspaceAccessDenied(httpError(403, controlBody))).toBe(true);
  });

  it("detects an intel-plane denial (nested detail.code)", () => {
    expect(isWorkspaceAccessDenied(httpError(403, intelBody))).toBe(true);
  });

  it("detects the denial from the inlined message even when .body is stripped", () => {
    // Some call sites re-wrap the HttpError and drop `.body`; the code still
    // rides in `.message` (buildError inlined it), so detection must survive.
    const e = httpError(403, controlBody) as Error & { status: number; body?: string };
    delete e.body;
    expect(isWorkspaceAccessDenied(e)).toBe(true);
  });

  it("is false for a 403 that is NOT a membership denial", () => {
    const other = httpError(403, JSON.stringify({ code: "FORBIDDEN", message: "nope" }));
    expect(isWorkspaceAccessDenied(other)).toBe(false);
  });

  it("is false for a non-403 status even if the code somehow appears", () => {
    expect(isWorkspaceAccessDenied(httpError(500, controlBody))).toBe(false);
  });

  it("is false for a socket error with no status", () => {
    const sock = new Error("ECONNREFUSED") as Error & { code?: string };
    sock.code = "ECONNREFUSED";
    expect(isWorkspaceAccessDenied(sock)).toBe(false);
  });

  it("is false for null / undefined / non-error input", () => {
    expect(isWorkspaceAccessDenied(null)).toBe(false);
    expect(isWorkspaceAccessDenied(undefined)).toBe(false);
    expect(isWorkspaceAccessDenied("boom")).toBe(false);
  });
});

describe("deniedWorkspaceId", () => {
  it("returns the requestedWorkspaceId from a control denial", () => {
    expect(deniedWorkspaceId(httpError(403, controlBody))).toBe("ws_target");
  });

  it("returns null for an intel denial (no requestedWorkspaceId field)", () => {
    expect(deniedWorkspaceId(httpError(403, intelBody))).toBeNull();
  });

  it("returns null for an unparseable body", () => {
    expect(deniedWorkspaceId(httpError(403, "<html>proxy error</html>"))).toBeNull();
  });
});

describe("workspaceAccessDeniedMessage", () => {
  it("returns the server's own message from a control denial", () => {
    expect(workspaceAccessDeniedMessage(httpError(403, controlBody))).toBe(CANONICAL);
  });

  it("returns the server's own message from an intel denial (detail.message)", () => {
    expect(workspaceAccessDeniedMessage(httpError(403, intelBody))).toBe(CANONICAL);
  });

  it("reconstructs the canonical line from a known workspace id when the body is unparseable", () => {
    const e = httpError(403, "<html>edge proxy rewrote this</html>");
    expect(workspaceAccessDeniedMessage(e, "ws_fallback")).toBe(
      "You are not a member of workspace 'ws_fallback'. Ask a workspace admin to add you to it.",
    );
  });

  it("falls back to the control-disclosed id when no known id is passed and the body is otherwise unparseable for a message", () => {
    // A 403 whose JSON carries the id in details but omits `message` (defensive:
    // an older control build) still reconstructs a usable line.
    const noMsg = httpError(
      403,
      JSON.stringify({ code: WORKSPACE_ACCESS_DENIED_CODE, details: { requestedWorkspaceId: "ws_disclosed" } }),
    );
    expect(workspaceAccessDeniedMessage(noMsg)).toBe(
      "You are not a member of workspace 'ws_disclosed'. Ask a workspace admin to add you to it.",
    );
  });

  it("degrades to 'unknown' when neither a server message, a disclosed id, nor a known id is available", () => {
    const e = httpError(403, "not json at all");
    expect(workspaceAccessDeniedMessage(e)).toBe(
      "You are not a member of workspace 'unknown'. Ask a workspace admin to add you to it.",
    );
  });
});
