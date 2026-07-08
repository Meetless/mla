import { isImmediateTerminal, buildTimeoutMessage } from "../../src/commands/review";

// Behavioral lock for the `mla review` poll loop terminal-state predicate
// (Wedge v6 Epoch 19).
//
// Before the fix, the loop tested `synthesisStatus === null` with strict
// equality. A backend response that omitted the field (synthesisStatus =
// undefined) fell through every branch and the loop spun the full 60s
// overall timeout before printing "Review not ready after 60s." for a
// packet that had ALREADY reached a terminal state on the server. This
// spec pins both null AND undefined as immediate-terminal so the
// silent-poll-until-timeout regression cannot return.

describe("isImmediateTerminal", () => {
  it("stops on status=failed regardless of synthesisStatus", () => {
    expect(isImmediateTerminal("failed", "pending")).toBe(true);
    expect(isImmediateTerminal("failed", "ready")).toBe(true);
    expect(isImmediateTerminal("failed", null)).toBe(true);
    expect(isImmediateTerminal("failed", undefined)).toBe(true);
  });

  it("stops on status=ready + synthesisStatus=ready", () => {
    expect(isImmediateTerminal("ready", "ready")).toBe(true);
  });

  it("stops on status=ready + synthesisStatus=failed", () => {
    expect(isImmediateTerminal("ready", "failed")).toBe(true);
  });

  it("stops on status=ready + synthesisStatus=null (no-synthesis packets)", () => {
    expect(isImmediateTerminal("ready", null)).toBe(true);
  });

  // The trap this epoch closed: the backend used to be allowed to return
  // a packet without the synthesisStatus key. The old strict `=== null`
  // check missed undefined and the loop ran out the clock.
  it("stops on status=ready + synthesisStatus=undefined (field omitted)", () => {
    expect(isImmediateTerminal("ready", undefined)).toBe(true);
  });

  it("keeps polling on status=ready + synthesisStatus=pending", () => {
    expect(isImmediateTerminal("ready", "pending")).toBe(false);
  });

  it("keeps polling on status=ready + synthesisStatus=not_started", () => {
    expect(isImmediateTerminal("ready", "not_started")).toBe(false);
  });

  it("keeps polling on status=pending regardless of synthesisStatus", () => {
    expect(isImmediateTerminal("pending", "not_started")).toBe(false);
    expect(isImmediateTerminal("pending", "pending")).toBe(false);
    expect(isImmediateTerminal("pending", null)).toBe(false);
    expect(isImmediateTerminal("pending", undefined)).toBe(false);
  });
});

// Behavioral lock for the operator-visible timeout message (Wedge v6
// Epoch 20). The poll loop used to track `lastStatus` / `lastSyn`
// internally but discard them with `void` statements and print a
// constant "Review not ready after 60s." That message leaves the
// operator unable to tell whether the worker is hung mid-base-build
// (status=pending) or synthesis is hung after base ready
// (status=ready, syn=pending) without a full `mla doctor` round-trip.
describe("buildTimeoutMessage", () => {
  it("includes the last observed status and synthesisStatus", () => {
    expect(buildTimeoutMessage("pending", "not_started")).toContain(
      "status=pending, syn=not_started",
    );
    expect(buildTimeoutMessage("ready", "pending")).toContain(
      "status=ready, syn=pending",
    );
  });

  it("still points the operator at mla doctor for both hang shapes", () => {
    const baseHang = buildTimeoutMessage("pending", "not_started");
    const synthHang = buildTimeoutMessage("ready", "pending");
    expect(baseHang).toMatch(/mla doctor/);
    expect(synthHang).toMatch(/mla doctor/);
  });

  it("renders the n/a sentinel when synthesisStatus was never observed", () => {
    // The pollForPacket loop initializes lastSyn to "?" but switches to
    // "n/a" on the first packet read when synthesisStatus is null. The
    // message must accept the sentinel through verbatim.
    expect(buildTimeoutMessage("?", "?")).toContain("status=?, syn=?");
    expect(buildTimeoutMessage("ready", "n/a")).toContain("status=ready, syn=n/a");
  });
});
