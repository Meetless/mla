import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { acquireBindingLock } from "../../../src/lib/agent-memory-capture/lock";
import { lockPath } from "../../../src/lib/agent-memory-capture/paths";

const NOW = "2026-06-27T00:00:00.000Z";
// Far above macOS's default max pid; process.kill(.,0) throws ESRCH -> treated dead.
const DEAD_PID = 999999;

describe("acquireBindingLock (CONCURRENCY-1)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amlock-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("acquires when free and records the holder pid", () => {
    const lock = acquireBindingLock("b1", NOW, home);
    expect(lock).not.toBeNull();
    const holder = readFileSync(lockPath("b1", home), "utf8").split("\n")[0].trim();
    expect(Number(holder)).toBe(process.pid);
    lock!.release();
  });

  it("returns null while a LIVE holder (this process) owns it", () => {
    const first = acquireBindingLock("b1", NOW, home);
    expect(first).not.toBeNull();
    const second = acquireBindingLock("b1", NOW, home);
    expect(second).toBeNull(); // non-blocking: skip this pass
    first!.release();
  });

  it("re-acquires after release", () => {
    const first = acquireBindingLock("b1", NOW, home);
    first!.release();
    expect(existsSync(lockPath("b1", home))).toBe(false);
    const second = acquireBindingLock("b1", NOW, home);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("steals a stale lockfile left by a dead pid (self-release-on-death property)", () => {
    const path = lockPath("b1", home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${DEAD_PID}\n2020-01-01T00:00:00.000Z\n`);
    const lock = acquireBindingLock("b1", NOW, home);
    expect(lock).not.toBeNull();
    const holder = readFileSync(path, "utf8").split("\n")[0].trim();
    expect(Number(holder)).toBe(process.pid); // rewritten with our pid
    lock!.release();
  });

  it("release is idempotent", () => {
    const lock = acquireBindingLock("b1", NOW, home);
    lock!.release();
    expect(() => lock!.release()).not.toThrow();
  });

  it("isolates locks per binding id", () => {
    const a = acquireBindingLock("a", NOW, home);
    const b = acquireBindingLock("b", NOW, home);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!.release();
    b!.release();
  });
});
