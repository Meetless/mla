// src/lib/agent-memory-capture/binding.ts
//
// The local capture-binding registry (§3). One binding per canonical memory
// directory (its realpath is the identity key). Reactivation of the same
// directory + workspace REUSES the bindingId; disable preserves it; never
// deletes it. The synthetic source path embeds the bindingId, so a regenerated
// id would fork one physical file into duplicate server sources.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { HOME } from "../config";
import { bindingsPath } from "./paths";
import type { BindingStore, MemoryBinding } from "./types";

function emptyStore(): BindingStore {
  return { version: 1, bindings: [] };
}

export function readBindingStore(home: string = HOME): BindingStore {
  let raw: string;
  try {
    raw = readFileSync(bindingsPath(home), "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BindingStore>;
    if (!parsed || !Array.isArray(parsed.bindings)) return emptyStore();
    return { version: 1, bindings: parsed.bindings as MemoryBinding[] };
  } catch {
    return emptyStore();
  }
}

export function writeBindingStore(store: BindingStore, home: string = HOME): void {
  const dest = bindingsPath(home);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, dest);
}

// Resolve a directory to its canonical realpath. Returns null when the path does
// not resolve (missing dir): the caller surfaces an actionable diagnostic
// rather than persisting an unverifiable binding.
export function canonicalizeDir(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

export type EnableOutcome =
  | { ok: true; binding: MemoryBinding; reactivated: boolean }
  | { ok: false; reason: "unresolved-dir" | "workspace-conflict"; conflictWorkspaceId?: string };

// Enable (or reactivate) capture for a directory + workspace. Reuses the
// bindingId when one already exists for the same canonical directory. A request
// to bind a directory already bound to a DIFFERENT workspace is a
// MEMORY-WORKSPACE-1 conflict: refuse and report (the caller disables nothing
// silently; one directory binds exactly one workspace).
export function enableBinding(
  rawDir: string,
  workspaceId: string,
  nowIso: string,
  home: string = HOME,
): EnableOutcome {
  const memoryDir = canonicalizeDir(rawDir);
  if (!memoryDir) return { ok: false, reason: "unresolved-dir" };

  const store = readBindingStore(home);
  const existing = store.bindings.find((b) => b.memoryDir === memoryDir);

  if (existing && existing.workspaceId !== workspaceId) {
    return {
      ok: false,
      reason: "workspace-conflict",
      conflictWorkspaceId: existing.workspaceId,
    };
  }

  if (existing) {
    const reactivated = !existing.enabled;
    existing.enabled = true;
    // Preserve bindingId and consentedAt; the binding is the same one.
    writeBindingStore(store, home);
    return { ok: true, binding: existing, reactivated };
  }

  const binding: MemoryBinding = {
    bindingId: randomUUID(),
    memoryDir,
    workspaceId,
    enabled: true,
    consentedAt: nowIso,
  };
  store.bindings.push(binding);
  writeBindingStore(store, home);
  return { ok: true, binding, reactivated: false };
}

// Disable a binding for a directory. Preserves the bindingId so a later
// reactivation keeps the same synthetic source identity. Returns the binding if
// one was found.
export function disableBinding(rawDir: string, home: string = HOME): MemoryBinding | null {
  const memoryDir = canonicalizeDir(rawDir) ?? rawDir;
  const store = readBindingStore(home);
  const binding = store.bindings.find((b) => b.memoryDir === memoryDir);
  if (!binding) return null;
  binding.enabled = false;
  writeBindingStore(store, home);
  return binding;
}

export function listBindings(home: string = HOME): MemoryBinding[] {
  return readBindingStore(home).bindings;
}

export function listEnabledBindings(home: string = HOME): MemoryBinding[] {
  return readBindingStore(home).bindings.filter((b) => b.enabled);
}
