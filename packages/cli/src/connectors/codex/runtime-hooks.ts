// Codex hook wrappers must execute the scripts shipped with the SAME mla binary.
//
// Claude Code invokes ~/.meetless/hooks/*.sh directly, so that shared directory
// remains the connector-neutral install target. Codex invokes an mla subcommand
// first, which gives us a stronger option: materialize this binary's templates
// into an immutable, content-addressed directory and run them there. This avoids
// a mixed-version race where an older concurrently-running mla auto-resyncs the
// shared directory between a newer Codex install and the next hook event.

import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { HOME } from "../../lib/config";
import { locateHooksTemplateDir } from "../../lib/wire";

const READY_FILE = ".ready";

export interface CodexRuntimeHookOptions {
  templateDir?: string;
  runtimeRoot?: string;
}

interface TemplateFile {
  name: string;
  bytes: Buffer;
}

function readTemplateFiles(templateDir: string): TemplateFile[] {
  const files: TemplateFile[] = [];
  for (const name of fs.readdirSync(templateDir).sort()) {
    const source = path.join(templateDir, name);
    if (!fs.statSync(source).isFile()) continue;
    files.push({ name, bytes: fs.readFileSync(source) });
  }
  return files;
}

function contentId(files: TemplateFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(name.length, 0);
    lengths.writeUInt32BE(file.bytes.length, 4);
    hash.update(lengths);
    hash.update(name);
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

function ready(runtimeDir: string, id: string): boolean {
  try {
    return fs.readFileSync(path.join(runtimeDir, READY_FILE), "utf8").trim() === id;
  } catch {
    return false;
  }
}

function atomicWrite(target: string, bytes: Buffer | string, mode?: number): void {
  const nonce = randomBytes(6).toString("hex");
  const temporary = `${target}.tmp-${process.pid}-${nonce}`;
  try {
    fs.writeFileSync(temporary, bytes);
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } finally {
    // A rename removes the temporary path. This only cleans up the exact file
    // owned by this invocation when a write/chmod/rename failed midway.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Capture is fail-open; the outer wrapper handles any material failure.
    }
  }
}

/**
 * Return an on-disk hook directory containing the exact templates shipped by
 * this mla process. Directories are immutable by convention and keyed by all
 * template bytes, so different installed CLI versions never overwrite one
 * another. The ready marker is written last; concurrent identical provisioners
 * may duplicate copies, but no caller observes a partially prepared bundle.
 */
export function ensureCodexRuntimeHooks(
  opts: CodexRuntimeHookOptions = {},
): string {
  const templateDir = opts.templateDir ?? locateHooksTemplateDir();
  const runtimeRoot = opts.runtimeRoot ?? path.join(HOME, "codex-hooks");
  const files = readTemplateFiles(templateDir);
  const id = contentId(files);
  const runtimeDir = path.join(runtimeRoot, id);

  if (ready(runtimeDir, id)) return runtimeDir;

  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const file of files) {
    atomicWrite(
      path.join(runtimeDir, file.name),
      file.bytes,
      file.name.endsWith(".sh") ? 0o755 : undefined,
    );
  }
  atomicWrite(path.join(runtimeDir, READY_FILE), `${id}\n`, 0o644);
  return runtimeDir;
}
