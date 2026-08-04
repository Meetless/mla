// EPIPE containment at the process edge.
//
// Sentry MEETLESS-CLI-2 (`Error: write EPIPE`, level FATAL, culprit
// `maybePrintDeepLink(lib:observability)`, 2 events 2026-08-02) is the observed
// instance, but the crash surface is every one of the CLI's 11 bare
// `process.stdout.write` sites, and the ones that matter are the HOOK entrypoints:
// pretool-entry, codex-hook, evidence-hooks, capture-decisions, pretool-observe. Their
// stdout is a pipe owned by a parent (Claude Code, Codex) that can close it at any
// moment, and Node surfaces that as an `error` EVENT on the stream, not as a promise
// rejection. cli.ts's `.catch()` and pretool-entry's `try/catch` are both structurally
// unable to see it, so it lands as an uncaught exception and kills the process.
//
// That inverts pretool-entry's own stated invariant ("fail OPEN (exit 0) on any
// unexpected rejection so an entrypoint fault can never escalate into a blocking hook
// decision"): a closed pipe currently turns a permissive hook into a crashed one.
//
// The guard swallows EPIPE (and ERR_STREAM_DESTROYED, the same event under a different
// code once the stream has already been torn down) and RE-THROWS everything else, so it
// cannot become a blanket silencer for real IO faults.
import { installStdioEpipeGuard } from "../../src/lib/stdio-guard";

type Fake = {
  listeners: Array<(e: unknown) => void>;
  on(ev: string, fn: (e: unknown) => void): void;
  listenerCount(ev: string): number;
  emit(e: unknown): void;
};

function fakeStream(): Fake {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    listeners,
    on(ev, fn) {
      if (ev === "error") listeners.push(fn);
    },
    listenerCount(ev) {
      return ev === "error" ? listeners.length : 0;
    },
    emit(e) {
      for (const fn of listeners) fn(e);
    },
  };
}

describe("installStdioEpipeGuard", () => {
  it("swallows EPIPE on stdout instead of letting it become an uncaught exception", () => {
    const out = fakeStream();
    const err = fakeStream();
    installStdioEpipeGuard({ stdout: out as never, stderr: err as never });

    expect(() => out.emit({ code: "EPIPE" })).not.toThrow();
  });

  it("swallows EPIPE on stderr too", () => {
    const out = fakeStream();
    const err = fakeStream();
    installStdioEpipeGuard({ stdout: out as never, stderr: err as never });

    expect(() => err.emit({ code: "EPIPE" })).not.toThrow();
  });

  it("swallows ERR_STREAM_DESTROYED, the same close under a later code", () => {
    const out = fakeStream();
    installStdioEpipeGuard({ stdout: out as never, stderr: fakeStream() as never });

    expect(() => out.emit({ code: "ERR_STREAM_DESTROYED" })).not.toThrow();
  });

  it("RE-THROWS a non-EPIPE stream error, so it is not a blanket silencer", () => {
    const out = fakeStream();
    installStdioEpipeGuard({ stdout: out as never, stderr: fakeStream() as never });

    const boom = Object.assign(new Error("disk on fire"), { code: "ENOSPC" });
    expect(() => out.emit(boom)).toThrow("disk on fire");
  });

  it("is idempotent: calling it twice does not stack duplicate listeners", () => {
    const out = fakeStream();
    const err = fakeStream();
    installStdioEpipeGuard({ stdout: out as never, stderr: err as never });
    installStdioEpipeGuard({ stdout: out as never, stderr: err as never });

    expect(out.listenerCount("error")).toBe(1);
    expect(err.listenerCount("error")).toBe(1);
  });
});
