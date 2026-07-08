import * as fs from "fs";
import * as path from "path";
import { buildRequestHeaders } from "../../src/lib/http";

// Behavioral lock for the conditional Content-Type header (Wedge v6 Epoch 28).
//
// Pre-fix http.ts unconditionally sent `Content-Type: application/json` on
// EVERY request, including body-less GETs. Per CLAUDE.md "Hard-Won Platform
// Lessons" (macOS/Node.js): Express's `body-parser` json() middleware silently
// returns HTTP 400 with no body on a GET that advertises a JSON Content-Type
// but has no body. The CLI's HttpError surfaces "HTTP 400: " with no
// diagnostic, and the operator gets no signal as to why doctor or whoami
// suddenly went red. RFC 7231 §3.1.1.5 also forbids sending Content-Type
// without a payload. Post-fix the header is omitted on body-less calls.

describe("buildRequestHeaders", () => {
  it("body-less call (GET) returns ONLY Authorization", () => {
    const h = buildRequestHeaders("tok_xyz", false);
    expect(h.Authorization).toBe("Bearer tok_xyz");
    expect(h["Content-Type"]).toBeUndefined();
    expect(Object.keys(h)).toEqual(["Authorization"]);
  });

  it("body-bearing call (POST/PATCH) returns Authorization AND Content-Type", () => {
    const h = buildRequestHeaders("tok_xyz", true);
    expect(h.Authorization).toBe("Bearer tok_xyz");
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("token interpolation handles arbitrary strings without leaking the Bearer prefix", () => {
    const h = buildRequestHeaders("abc 123", true);
    expect(h.Authorization).toBe("Bearer abc 123");
  });

  // T1.4 (folder = workspace): control writes must carry the caller's identity
  // so the membership guard (INV-AUTH-1) can resolve a WorkspaceUser. The actor
  // is self-asserted from cli-config.actorUserId and threaded as the
  // X-Meetless-Actor header on EVERY control request (harmless on reads; load
  // bearing on agent-review writes).
  it("stamps X-Meetless-Actor when an actor is provided", () => {
    const h = buildRequestHeaders("tok_xyz", true, "wu_an_local_owner");
    expect(h["X-Meetless-Actor"]).toBe("wu_an_local_owner");
    expect(h.Authorization).toBe("Bearer tok_xyz");
  });

  it("stamps X-Meetless-Actor on a body-less call too (reads carry identity harmlessly)", () => {
    const h = buildRequestHeaders("tok_xyz", false, "wu_an_local_owner");
    expect(h["X-Meetless-Actor"]).toBe("wu_an_local_owner");
    expect(h["Content-Type"]).toBeUndefined();
  });

  it("omits X-Meetless-Actor when no actor is provided (mla init / config-less path)", () => {
    expect(buildRequestHeaders("tok_xyz", true)["X-Meetless-Actor"]).toBeUndefined();
    expect(buildRequestHeaders("tok_xyz", true, "")["X-Meetless-Actor"]).toBeUndefined();
    expect(buildRequestHeaders("tok_xyz", true, "   ")["X-Meetless-Actor"]).toBeUndefined();
  });

  // Drift guard: if a future refactor removes the conditional and reverts to
  // unconditional Content-Type, the Express silent-400 trap returns. This
  // grep-style assertion fails before that change can land.
  it("http.ts KEEPS the conditional `if (hasBody)` guard (drift guard)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/lib/http.ts"),
      "utf8",
    );
    expect(src).toMatch(/if \(hasBody\)/);
    // T1.4: the doFetch call site now threads the actor as a 3rd arg. The
    // 2nd arg MUST stay `hasBody` (never a hardcoded `true`, which would
    // re-introduce the Express silent-400 trap on body-less calls).
    expect(src).toMatch(
      /buildRequestHeaders\(\s*cfg\.controlToken\s*,\s*hasBody\s*,\s*cfg\.actorUserId\s*\)/,
    );
    // No call site should pass a hardcoded `true` for hasBody (regression
    // shape that would silently re-introduce the trap).
    expect(src).not.toMatch(/buildRequestHeaders\([^,]+,\s*true\s*[,)]/);
  });
});
