// Local analytics store: the append-only ~/.meetless/events.jsonl (spec section
// 7.4, INV-LOCAL-STATS-1/2). This file is the source of truth for `mla stats`
// (offline, OSS-safe, no backend required) and the local correlator's working
// set. It is NEVER the source of truth for `--global` (that reads control
// rollups).
//
// Every write is gated by localStatsEnabled() so a user who turns local stats
// off leaves no trace on disk. Reads are lenient: a malformed line is skipped,
// never fatal, so a half-written line (crash mid-append) can't brick `mla stats`.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { HOME } from "../config";
import { localStatsEnabled } from "./consent";
import { AnalyticsEvent } from "./envelope";

export function eventsPath(): string {
  return path.join(HOME, "events.jsonl");
}

// A stable, non-identifying machine id for distinct_id when no workspace user is
// resolved. Derived from the hostname + home dir so it is consistent per machine
// but carries no account data. Hashed so the raw hostname never lands in jsonl.
let cachedMachineId: string | null = null;
export function machineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const seed = `${os.hostname()}::${os.homedir()}`;
  cachedMachineId = "m_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return cachedMachineId;
}

function ensureHome(): void {
  if (!fs.existsSync(HOME)) {
    fs.mkdirSync(HOME, { recursive: true });
  }
}

// events.jsonl is append-only and written on nearly every mla command, so left
// unbounded it grows without limit. Two costs compound: the file itself, and the
// local correlator, which re-reads the ENTIRE file on every Stop hook (O(total
// events) per turn). We cap it with a lazy rolling tail: when the file crosses a
// high-water byte mark we keep only the newest low-water bytes of complete lines.
// This is a local, offline, best-effort stats file (never the source of truth for
// `--global`), so dropping the oldest events is acceptable -- `mla stats` reflects
// recent history and the correlator only ever needs recent turns.
//
// The stat() is one cheap syscall per append; the O(file) rewrite happens only
// when the file is over the cap, which -- because each rewrite drops the file well
// below the high-water mark -- is rare and amortizes to near-zero.
const DEFAULT_EVENTS_MAX_BYTES = 5 * 1024 * 1024; // high-water: rotate above this
const DEFAULT_EVENTS_KEEP_BYTES = 3 * 1024 * 1024; // low-water: newest tail to retain

function boundEnvInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function capEventsFileIfNeeded(env: NodeJS.ProcessEnv): void {
  const maxBytes = boundEnvInt(env, "MEETLESS_EVENTS_MAX_BYTES", DEFAULT_EVENTS_MAX_BYTES);
  const keepBytes = Math.min(
    boundEnvInt(env, "MEETLESS_EVENTS_KEEP_BYTES", DEFAULT_EVENTS_KEEP_BYTES),
    maxBytes,
  );
  const file = eventsPath();
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet (or unreadable) -- nothing to cap
  }
  if (size <= maxBytes) return;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  // Walk from the newest line backward, retaining lines until we would exceed the
  // low-water tail. Always keep at least the newest line so a single oversized
  // line can't wipe the file.
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i], "utf8") + 1; // + newline
    if (kept.length > 0 && bytes + b > keepBytes) break;
    kept.push(lines[i]);
    bytes += b;
  }
  kept.reverse();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, kept.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file); // atomic swap on same filesystem
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
}

// Append one event as a single jsonl line. No-op when local stats are disabled.
// Best-effort: a disk error is swallowed (analytics must never break a command),
// but we surface it on the debug channel via the optional onError hook.
export function appendEvent(
  ev: AnalyticsEvent,
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
): void {
  if (!localStatsEnabled(env)) return;
  try {
    ensureHome();
    capEventsFileIfNeeded(env);
    fs.appendFileSync(eventsPath(), JSON.stringify(ev) + "\n", "utf8");
  } catch (err) {
    if (onError) onError(err);
  }
}

// Append a raw pre-serialized line (used by the correlator when it rewrites an
// outcome). Same gating + best-effort semantics.
export function appendEventLine(
  line: string,
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
): void {
  if (!localStatsEnabled(env)) return;
  try {
    ensureHome();
    capEventsFileIfNeeded(env);
    const normalized = line.endsWith("\n") ? line : line + "\n";
    fs.appendFileSync(eventsPath(), normalized, "utf8");
  } catch (err) {
    if (onError) onError(err);
  }
}

// Read all events from the local jsonl. Lenient parser: blank and malformed
// lines are skipped. Returns [] when the file is absent or local stats are off.
export function readEvents(env: NodeJS.ProcessEnv = process.env): AnalyticsEvent[] {
  if (!localStatsEnabled(env)) return [];
  const file = eventsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AnalyticsEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AnalyticsEvent);
    } catch {
      // Skip a half-written or corrupt line; never fail the read.
    }
  }
  return out;
}
