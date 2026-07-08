// tools/meetless-agent/test/lib/identity-envelope.spec.ts
import { dedupIdentity, scopeKey, IdentityEnvelope } from "../../src/lib/identity-envelope";

const base: IdentityEnvelope = {
  workspaceId: "ws_1",
  ownerUserId: "user_a",
  repoRootHash: "repoA",
  canonicalPath: "notes/x.md",
  contentHash: "hashA",
  sessionId: "sess_1",
  turnIndex: 3,
  sourceProduct: "claude_code",
  kind: "produced_doc",
  createdAt: "2026-06-04T00:00:00Z",
};

describe("identity-envelope", () => {
  it("scopeKey is workspace+repo+owner", () => {
    expect(scopeKey(base)).toBe("ws_1|repoA|user_a");
  });

  it("dedupIdentity is owner-isolated (test 32): same path+content, different owner, different identity", () => {
    const a = dedupIdentity(base);
    const b = dedupIdentity({ ...base, ownerUserId: "user_b" });
    expect(a).not.toBe(b);
  });

  it("path-collision isolation (test 5): same path+content, different repoRootHash, different identity", () => {
    const a = dedupIdentity(base);
    const b = dedupIdentity({ ...base, repoRootHash: "repoB" });
    expect(a).not.toBe(b);
  });

  it("content change yields a new dedup identity (test 4 precondition)", () => {
    expect(dedupIdentity(base)).not.toBe(dedupIdentity({ ...base, contentHash: "hashB" }));
  });
});
