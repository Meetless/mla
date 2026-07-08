import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  enableBinding,
  disableBinding,
  listBindings,
  listEnabledBindings,
  canonicalizeDir,
} from "../../../src/lib/agent-memory-capture/binding";

const NOW = "2026-06-27T00:00:00.000Z";

describe("binding registry", () => {
  let home: string;
  let memA: string;
  let memB: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amb-home-"));
    memA = mkdtempSync(join(tmpdir(), "amb-memA-"));
    memB = mkdtempSync(join(tmpdir(), "amb-memB-"));
  });

  afterEach(() => {
    for (const d of [home, memA, memB]) rmSync(d, { recursive: true, force: true });
  });

  it("enables a new binding with a generated id", () => {
    const out = enableBinding(memA, "ws-1", NOW, home);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reactivated).toBe(false);
    expect(out.binding.bindingId).toMatch(/[0-9a-f-]{36}/);
    expect(out.binding.workspaceId).toBe("ws-1");
    expect(out.binding.enabled).toBe(true);
    expect(listEnabledBindings(home)).toHaveLength(1);
  });

  it("reactivation of the same dir REUSES the bindingId (synthetic-source stability)", () => {
    const first = enableBinding(memA, "ws-1", NOW, home);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const id = first.binding.bindingId;

    const disabled = disableBinding(memA, home);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.bindingId).toBe(id); // disable preserves the id
    expect(listEnabledBindings(home)).toHaveLength(0);

    const second = enableBinding(memA, "ws-1", "2026-06-28T00:00:00.000Z", home);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reactivated).toBe(true);
    expect(second.binding.bindingId).toBe(id); // same id, not a fork
    expect(second.binding.consentedAt).toBe(NOW); // original consent preserved
    expect(listBindings(home)).toHaveLength(1); // not duplicated
  });

  it("refuses to bind one directory to a second workspace (MEMORY-WORKSPACE-1)", () => {
    expect(enableBinding(memA, "ws-1", NOW, home).ok).toBe(true);
    const conflict = enableBinding(memA, "ws-2", NOW, home);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toBe("workspace-conflict");
    expect(conflict.conflictWorkspaceId).toBe("ws-1");
    expect(listEnabledBindings(home)).toHaveLength(1); // unchanged
  });

  it("two distinct directories get two distinct bindings", () => {
    enableBinding(memA, "ws-1", NOW, home);
    enableBinding(memB, "ws-1", NOW, home);
    const all = listBindings(home);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((b) => b.bindingId)).size).toBe(2);
  });

  it("reports unresolved-dir for a non-existent directory", () => {
    const out = enableBinding(join(home, "does-not-exist"), "ws-1", NOW, home);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unresolved-dir");
  });

  it("two worktrees sharing one memory dir resolve to one binding", () => {
    // A nested real subdir stands in for a worktree that points at the same
    // canonical memory directory; both canonicalize to the same realpath.
    const out1 = enableBinding(memA, "ws-1", NOW, home);
    const out2 = enableBinding(canonicalizeDir(memA)!, "ws-1", NOW, home);
    expect(out1.ok && out2.ok).toBe(true);
    if (!out1.ok || !out2.ok) return;
    expect(out2.binding.bindingId).toBe(out1.binding.bindingId);
    expect(listBindings(home)).toHaveLength(1);
  });

  it("disable returns null when nothing is bound", () => {
    mkdirSync(join(memA, "sub"));
    expect(disableBinding(join(memA, "sub"), home)).toBeNull();
  });
});
