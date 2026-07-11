// Native-addon loader shim for the pkg single-file binary.
//
// better-sqlite3 is a native addon: its compiled `better_sqlite3.node` is loaded
// with dlopen, which requires a real on-disk file. In a @yao-pkg/pkg binary the
// module tree lives inside the read-only `/snapshot` virtual filesystem, and the
// `bindings` resolver only ever probes `/snapshot/.../build/Release/...` paths
// that dlopen cannot open. The symptom is the raw:
//
//   Could not locate the bindings file. Tried:
//    -> /snapshot/meetless-cli/node_modules/.pnpm/better-sqlite3@.../better_sqlite3.node
//
// which kills the CE0 interception store on EVERY packaged platform (macOS + the
// linux-x64 binary WSL users install), not just Windows/WSL.
//
// Fix: the build embeds the build-host's `better_sqlite3.node` as a pkg asset at
// `dist/native/better_sqlite3.node` (scripts/copy-assets.js + package.json
// "pkg.assets"). Because each release target is built on its OWN native runner
// (macos-arm64 on macos-14, linux-x64 on ubuntu-latest), the embedded addon
// always matches the target ABI. At runtime we read those asset bytes out of the
// snapshot (pkg patches fs to serve assets) and write them to a real temp file,
// then hand better-sqlite3 that real path via its `nativeBinding` option, whose
// string form is loaded with a plain require() of a path we control
// (better-sqlite3/lib/database.js). No dependence on pkg's flaky static `.node`
// detection.
//
// Outside a pkg binary (dev tree, npm/source install) there is no snapshot: we
// return undefined and better-sqlite3 resolves the addon the normal way.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// undefined = not yet resolved; null = resolved to "use default resolution".
let cached: string | null | undefined;

/**
 * Absolute path to a real, dlopen-able `better_sqlite3.node`, or undefined when
 * the process is not a pkg binary (let better-sqlite3 find it itself). Safe to
 * call on every open: the temp copy is written once and memoized.
 */
export function betterSqlite3NativeBinding(): string | undefined {
  // `process.pkg` is defined only inside a @yao-pkg/pkg binary.
  if (!(process as { pkg?: unknown }).pkg) return undefined;
  if (cached !== undefined) return cached ?? undefined;

  try {
    // This module compiles to dist/lib/rules/native-binding.js; the embedded
    // addon is at dist/native/better_sqlite3.node -> ../../native/ from here.
    // __dirname is snapshot-root-relative, so this holds regardless of where pkg
    // mounts the snapshot base.
    const embedded = path.join(__dirname, "..", "..", "native", "better_sqlite3.node");
    const bytes = fs.readFileSync(embedded);

    // Key the extracted copy by byte length so a new release's addon never loads
    // a stale sibling left in tmp by a prior version.
    const dir = path.join(os.tmpdir(), "mla-native");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `better_sqlite3-${bytes.length}.node`);

    if (!fs.existsSync(dest)) {
      // Publish atomically: concurrent Claude Code hooks (PreToolUse/Stop) can
      // open the store at the same time, so write to a pid-unique temp and rename
      // so no reader ever sees a half-written .node.
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      try {
        fs.renameSync(tmp, dest);
      } catch {
        // A racing writer won the rename; our copy is redundant. Clean up.
        fs.rmSync(tmp, { force: true });
      }
    }
    cached = dest;
  } catch {
    // Materialization failed (unexpected). Fall back to default resolution: no
    // worse than today, and dev/source installs are unaffected.
    cached = null;
  }
  return cached ?? undefined;
}
