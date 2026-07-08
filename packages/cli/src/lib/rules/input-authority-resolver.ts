import { createHash } from "crypto";
import * as path from "path";

import { canonicalize, type CanonicalObject } from "./canonical-json";
import { isManagedHookCommand } from "../wire";

// The effective-hook-config resolver (R1 foundation), the mechanical proof behind
// INV-R1-SINGLE-INPUT-AUTHORITY (P0.19) made continuous by INV-R1-INPUT-AUTHORITY-IS-CONTINUOUS
// (P0.58) in notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md (§2.4).
//
// Claude Code runs every matching PreToolUse hook in PARALLEL and an `updatedInput` REPLACES the whole
// tool input, so there is no safe composition contract when two hooks both rewrite input. R1 may only
// emit a deny while it can mechanically prove the NARROW v1 condition: MLA is the SOLE effective
// PreToolUse hook that matches Write or Edit across the entire config hierarchy. This module is the
// PURE core of that proof. It is given the five already-loaded settings layers (user, project, local,
// plugin, managed) and:
//   - enumerates every effective PreToolUse command hook,
//   - identifies which ones match the governed tools (Write / Edit),
//   - classifies each as MLA-owned or foreign (reusing the installer's own ownership predicate so the
//     resolver can never drift from what `mla init` writes),
//   - returns MLA_SOLE_AUTHORITY, or a typed unavailable reason,
//   - and emits a deterministic, order-independent canonical snapshot + hash for the
//     `inputAuthorityConfigHash` audit field on tool_attempt.
//
// It touches no network and no filesystem (the IO shell that reads the settings files and calls this
// lives in the runtime / `mla doctor`, which both reuse this resolver). It emits NO deny: it only
// reports whether a deny would be admissible. Every ambiguity fails CLOSED to UNAVAILABLE, never to a
// silent OBSERVE downgrade (P0.15).

export const HOOK_CONFIG_LAYERS = ["user", "project", "local", "plugin", "managed"] as const;
export type HookConfigLayerName = (typeof HOOK_CONFIG_LAYERS)[number];

/** Domain tag for the snapshot hash; the single 0x00 separator (P0.53) prevents cross-domain collision. */
export const INPUT_AUTHORITY_CONFIG_DOMAIN = "effective-hook-config-v1";

/** The script `mla init` registers as the managed PreToolUse hook; the MLA-ownership probe. */
const MLA_PRE_TOOL_USE_SCRIPT = "pre-tool-use.sh";

/** The tools the R1 pilot governs. Only a PreToolUse hook matching one of these can threaten deny. */
const GOVERNED_TOOLS = ["Write", "Edit"] as const;

/**
 * One config layer, as the IO shell hands it in. A readable layer carries its parsed `settings`
 * object (which may be `{}` when the file is absent); a layer whose file exists but could not be read
 * or parsed is marked `unreadable` so the resolver can fail closed on an incomplete picture.
 */
export type HookConfigLayer =
  | { name: HookConfigLayerName; settings: unknown; unreadable?: false }
  | { name: HookConfigLayerName; unreadable: true; error: string };

/** Options injected so the resolver stays pure: the absolute path to MLA's hooks directory. */
export interface ResolveInputAuthorityOptions {
  /** Typically `${MEETLESS_HOME || ~/.meetless}/hooks`; a fixture dir under tests. */
  mlaHooksDir: string;
}

/** An interpreted PreToolUse hook that matches at least one governed tool. */
export interface MatchedHookCommand {
  layer: HookConfigLayerName;
  matcher: string;
  command: string;
  matchesWrite: boolean;
  matchesEdit: boolean;
  mutatorClass: "MLA" | "FOREIGN";
}

export type InputAuthorityUnavailableReason =
  /** A config layer's file existed but could not be read/parsed: the picture is incomplete. */
  | "CONFIG_LAYER_UNREADABLE"
  /** A PreToolUse entry or its matcher could not be interpreted (bad regex, malformed shape). */
  | "HOOK_ENTRY_UNINTERPRETABLE"
  /** A non-MLA PreToolUse hook also matches Write/Edit: composition is unsafe. */
  | "FOREIGN_MUTATOR_PRESENT"
  /** No MLA PreToolUse hook matches Write/Edit: MLA cannot be the input authority. */
  | "MLA_HOOK_ABSENT";

export type InputAuthorityResolution =
  | {
      kind: "MLA_SOLE_AUTHORITY";
      configHash: string;
      snapshot: string;
      matchedCommands: MatchedHookCommand[];
    }
  | {
      kind: "UNAVAILABLE";
      reason: InputAuthorityUnavailableReason;
      detail: string;
      configHash: string;
      snapshot: string;
      matchedCommands: MatchedHookCommand[];
    };

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface RawEntry {
  layer: HookConfigLayerName;
  matcher: string;
  command: string;
}

function isUnreadable(
  layer: HookConfigLayer,
): layer is { name: HookConfigLayerName; unreadable: true; error: string } {
  return (layer as { unreadable?: boolean }).unreadable === true;
}

/**
 * Interpret a Claude Code matcher against the governed tools. `""` is the catch-all (matches every
 * tool). A non-empty matcher is a regex matched partially (Claude Code semantics). Returns null when
 * the matcher is not a valid regex, so the caller can fail closed.
 */
function interpretMatcher(matcher: string): { write: boolean; edit: boolean } | null {
  if (matcher === "") return { write: true, edit: true };
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return null;
  }
  return { write: re.test("Write"), edit: re.test("Edit") };
}

/** Defensively pull every PreToolUse command hook out of one readable layer's settings. */
function extractPreToolUse(
  layerName: HookConfigLayerName,
  settings: unknown,
  problems: string[],
): RawEntry[] {
  const out: RawEntry[] = [];
  if (!settings || typeof settings !== "object") return out;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") return out;
  const pre = (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (pre === undefined) return out;
  if (!Array.isArray(pre)) {
    problems.push(`${layerName}: PreToolUse is not an array`);
    return out;
  }
  for (const entry of pre) {
    if (!entry || typeof entry !== "object") {
      problems.push(`${layerName}: a PreToolUse entry is not an object`);
      continue;
    }
    const rawMatcher = (entry as { matcher?: unknown }).matcher;
    const matcher = rawMatcher === undefined ? "" : rawMatcher;
    if (typeof matcher !== "string") {
      problems.push(`${layerName}: a PreToolUse matcher is not a string`);
      continue;
    }
    const inner = (entry as { hooks?: unknown }).hooks;
    if (inner === undefined) continue;
    if (!Array.isArray(inner)) {
      problems.push(`${layerName}: a PreToolUse entry's hooks is not an array`);
      continue;
    }
    for (const h of inner) {
      if (!h || typeof h !== "object") {
        problems.push(`${layerName}: a hook is not an object`);
        continue;
      }
      // Only command hooks run a script that can return updatedInput; ignore any other type.
      if ((h as { type?: unknown }).type !== "command") continue;
      const command = (h as { command?: unknown }).command;
      if (typeof command !== "string" || command.length === 0) {
        problems.push(`${layerName}: a command hook has no string command`);
        continue;
      }
      out.push({ layer: layerName, matcher, command });
    }
  }
  return out;
}

/** Stable ordering over (command, matcher, layer) so the snapshot is independent of input order. */
function compareEntries(a: RawEntry, b: RawEntry): number {
  return (
    cmp(a.command, b.command) || cmp(a.matcher, b.matcher) || cmp(a.layer, b.layer)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function classify(command: string, mlaHooksDir: string): "MLA" | "FOREIGN" {
  const cmd = path.join(mlaHooksDir, MLA_PRE_TOOL_USE_SCRIPT);
  return isManagedHookCommand(command, MLA_PRE_TOOL_USE_SCRIPT, cmd) ? "MLA" : "FOREIGN";
}

/** Build the canonical snapshot object that is serialized and hashed. */
function buildSnapshot(rawEntries: RawEntry[], unreadableLayers: HookConfigLayerName[]): CanonicalObject {
  const preToolUse: CanonicalObject[] = [...rawEntries]
    .sort(compareEntries)
    .map((e) => ({ layer: e.layer, matcher: e.matcher, command: e.command }));
  return {
    schemaVersion: INPUT_AUTHORITY_CONFIG_DOMAIN,
    preToolUse,
    unreadableLayers: [...unreadableLayers].sort(),
  };
}

/** SHA-256(domainTag || 0x00 || JCS(snapshot)), lowercase hex. Mirrors observed-rule-hash.ts. */
function hashSnapshot(jcs: string): string {
  const h = createHash("sha256");
  h.update(INPUT_AUTHORITY_CONFIG_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// resolver
// ---------------------------------------------------------------------------

/**
 * Resolve whether MLA is the sole effective Write/Edit input authority across the given config
 * layers. Pure: no IO, no network, no deny. The result always carries the deterministic snapshot +
 * hash (computed over whatever was readable) for the audit field; the `kind` decides admissibility.
 */
export function resolveInputAuthority(
  layers: HookConfigLayer[],
  opts: ResolveInputAuthorityOptions,
): InputAuthorityResolution {
  const unreadableLayers: HookConfigLayerName[] = [];
  const problems: string[] = [];
  const rawEntries: RawEntry[] = [];

  for (const layer of layers) {
    if (isUnreadable(layer)) {
      unreadableLayers.push(layer.name);
      continue;
    }
    rawEntries.push(...extractPreToolUse(layer.name, layer.settings, problems));
  }

  // Any matcher that does not compile is uninterpretable; fail closed rather than guess its scope.
  for (const e of rawEntries) {
    if (interpretMatcher(e.matcher) === null) {
      problems.push(`${e.layer}: matcher ${JSON.stringify(e.matcher)} is not a valid regex`);
    }
  }

  // The interpreted set of hooks matching a governed tool (skips uninterpretable matchers defensively).
  const matchedCommands: MatchedHookCommand[] = [];
  for (const e of rawEntries) {
    const m = interpretMatcher(e.matcher);
    if (!m) continue;
    if (!m.write && !m.edit) continue;
    matchedCommands.push({
      layer: e.layer,
      matcher: e.matcher,
      command: e.command,
      matchesWrite: m.write,
      matchesEdit: m.edit,
      mutatorClass: classify(e.command, opts.mlaHooksDir),
    });
  }
  matchedCommands.sort(
    (a, b) => cmp(a.command, b.command) || cmp(a.matcher, b.matcher) || cmp(a.layer, b.layer),
  );

  const snapshot = canonicalize(buildSnapshot(rawEntries, unreadableLayers));
  const configHash = hashSnapshot(snapshot);

  const unavailable = (
    reason: InputAuthorityUnavailableReason,
    detail: string,
  ): InputAuthorityResolution => ({
    kind: "UNAVAILABLE",
    reason,
    detail,
    configHash,
    snapshot,
    matchedCommands,
  });

  // Severity order: an incomplete or uninterpretable picture beats any conclusion drawn from it.
  if (unreadableLayers.length > 0) {
    return unavailable(
      "CONFIG_LAYER_UNREADABLE",
      `config layers unreadable: ${[...unreadableLayers].sort().join(", ")}`,
    );
  }
  if (problems.length > 0) {
    return unavailable("HOOK_ENTRY_UNINTERPRETABLE", problems.join("; "));
  }

  const foreign = matchedCommands.filter((c) => c.mutatorClass === "FOREIGN");
  if (foreign.length > 0) {
    return unavailable(
      "FOREIGN_MUTATOR_PRESENT",
      `foreign Write/Edit PreToolUse mutators present: ${foreign.map((c) => c.command).join(", ")}`,
    );
  }

  const mla = matchedCommands.filter((c) => c.mutatorClass === "MLA");
  if (mla.length === 0) {
    return unavailable(
      "MLA_HOOK_ABSENT",
      `no MLA PreToolUse hook matches ${GOVERNED_TOOLS.join(" or ")}`,
    );
  }

  return { kind: "MLA_SOLE_AUTHORITY", configHash, snapshot, matchedCommands };
}
