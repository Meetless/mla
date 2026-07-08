import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveActiveRuntimeScopeId } from "../../../src/lib/rules/runtime-scope";

// The active runtime scope id is the realpath-resolved checkout root of the activated runtime
// project (proposal §2.3 / §10.1, P0.51 / decision 7): from the working directory, walk to the
// repo root and canonicalize via realpath. There is NO runtime-scope table for R0/R1; the resolved
// path string IS the scope identity. These tests exercise the two real derivations (git walk +
// non-git fallback) against real temp directories and a real git checkout, never a mock.

let dirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("resolveActiveRuntimeScopeId", () => {
  it("walks from a subdirectory to the git checkout root and canonicalizes it (realpath)", () => {
    const root = tmp("rt-scope-git-");
    execSync("git init -q", { cwd: root });
    const sub = path.join(root, "packages", "cli");
    fs.mkdirSync(sub, { recursive: true });

    const canonicalRoot = fs.realpathSync(root);
    expect(resolveActiveRuntimeScopeId(sub)).toBe(canonicalRoot);
    expect(resolveActiveRuntimeScopeId(root)).toBe(canonicalRoot);
  });

  it("falls back to the realpath of the working directory outside any git repo", () => {
    const d = tmp("rt-scope-nogit-");
    expect(resolveActiveRuntimeScopeId(d)).toBe(fs.realpathSync(d));
  });
});
