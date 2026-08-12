import {
  makeMcpStaleCheck,
  type StaleBuildIdentity,
} from "../../src/lib/staleness";

// The `mla mcp` server is long-lived and Node never hot-reloads dist, so a
// server spawned before a rebuild keeps serving the OLD in-memory code until the
// editor restarts it. That footgun is what produced the recurring
// "This operation was aborted" reports: servers predating the /v1/ask timeout fix
// kept aborting at the old 15s deadline. makeMcpStaleCheck snapshots the build
// identity (dist/build-info.json, stamped fresh by scripts/gen-build-info.js on
// every build) at spawn and, on each tool call, re-reads it: a newer build on
// disk means THIS process is stale, so it returns a one-line operator warning.
// It must fail OPEN (no warning) whenever a read is unavailable so dev builds
// (no build-info.json) never nag, and it must NEVER throw into a tool response.

function identity(over: Partial<StaleBuildIdentity> = {}): StaleBuildIdentity {
  return { sha: "aaaaaaa", builtAt: "2026-06-13T10:00:45.000Z", ...over };
}

describe("makeMcpStaleCheck", () => {
  it("returns null while the on-disk build identity is unchanged since spawn", () => {
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => identity() });
    expect(probe()).toBeNull();
    expect(probe()).toBeNull();
  });

  it("warns once a NEWER build (different builtAt) appears on disk after spawn", () => {
    let current = identity();
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    // A rebuild lands: gen-build-info stamps a fresh builtAt (and usually sha).
    current = identity({ sha: "bbbbbbb", builtAt: "2026-06-13T11:30:00.000Z" });
    const warning = probe();
    expect(typeof warning).toBe("string");
    // Names both builds and tells the operator the actionable remedy.
    expect(warning).toContain("aaaaaaa");
    expect(warning).toContain("bbbbbbb");
    expect(warning).toMatch(/restart/i);
  });

  it("warns when only the sha differs (a dirty rebuild of a new commit, same-second builtAt)", () => {
    let current = identity({ sha: "aaaaaaa" });
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    current = identity({ sha: "ccccccc" });
    expect(typeof probe()).toBe("string");
  });

  it("says SAME COMMIT, REBUILT when only builtAt moved, instead of printing one sha twice", () => {
    // HIT LIVE, 2026-08-09, on a real `retrieve_knowledge` call:
    //
    //   Meetless MCP is serving an OLDER build (55fc10b9d @ ...23.270Z);
    //   a newer mla build (55fc10b9d @ ...32.031Z) is now on disk.
    //
    // Nine seconds apart, IDENTICAL sha. The warning is CORRECT to fire: on a shared
    // tree a peer rebuilds constantly, and a dev build bakes in uncommitted working-tree
    // changes, so the same commit can produce genuinely different dist bytes. Restarting
    // is the right response.
    //
    // But an operator reading one sha printed twice under the words "OLDER" and "newer"
    // concludes the CHECK is broken, and starts ignoring it. That is the one outcome this
    // warning cannot afford, because its whole job is to be believed on the day it
    // matters. Name the case instead of rendering a tautology.
    let current = identity({ sha: "aaaaaaa", builtAt: "2026-06-13T10:30:00.000Z" });
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    current = identity({ sha: "aaaaaaa", builtAt: "2026-06-13T10:30:09.000Z" });

    const warning = probe() ?? "";

    expect(warning).toMatch(/same commit/i);
    // The remedy must survive the rewording: this is still a restart.
    expect(warning).toMatch(/restart/i);
    // And it must still carry both timestamps, which are the only thing that DID move.
    expect(warning).toContain("10:30:00.000Z");
    expect(warning).toContain("10:30:09.000Z");
  });

  it("still contrasts the two shas when the commit actually changed", () => {
    // Non-vacuity: the same-commit wording must not swallow the ordinary case, which is
    // the one the operator most needs to be able to read.
    let current = identity({ sha: "aaaaaaa" });
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    current = identity({ sha: "ddddddd", builtAt: "2026-06-13T12:00:00.000Z" });

    const warning = probe() ?? "";

    expect(warning).toContain("aaaaaaa");
    expect(warning).toContain("ddddddd");
    expect(warning).not.toMatch(/same commit/i);
  });

  it("never warns when there was no build identity at spawn (dev build, no build-info.json)", () => {
    let current: StaleBuildIdentity | null = null; // missing at spawn
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    // Even if a build-info.json later appears, a probe that had no spawn baseline
    // stays silent: it cannot distinguish "rebuilt" from "first ever stamp".
    current = identity();
    expect(probe()).toBeNull();
  });

  it("fails open (null) when the on-disk read disappears after a valid spawn", () => {
    let current: StaleBuildIdentity | null = identity();
    const probe = makeMcpStaleCheck({ readBuildIdentity: () => current });
    expect(probe()).toBeNull();
    current = null; // file removed / unreadable mid-session
    expect(probe()).toBeNull();
  });

  it("never throws into a tool response, even if the reader throws", () => {
    const probe = makeMcpStaleCheck({
      readBuildIdentity: () => {
        throw new Error("fs exploded");
      },
    });
    expect(() => probe()).not.toThrow();
    expect(probe()).toBeNull();
  });
});
