// Runtime detection of the pkg-compiled standalone binary.
//
// `mla` ships two ways: a @yao-pkg/pkg-compiled single-file binary (curl|sh and
// Homebrew) and a source/npm install on a real Node. The binary embeds its files
// in a V8 snapshot rooted at /snapshot, and @yao-pkg/pkg sets `process.pkg` in
// the packaged process. That snapshot has NO ESM dynamic-import callback, so any
// true runtime import() of an ESM-only module fails with "A dynamic import
// callback was not specified". `mla mcp` is exactly such a path (it
// dynamic-imports the ESM-only @meetless/mcp), so the dispatcher uses this to
// refuse cleanly in the binary rather than crash cryptically.
//
// From a source/npm install `process.pkg` is undefined and __dirname is a real
// path, so this returns false and every code path behaves exactly as before.
export function isPackagedBinary(): boolean {
  if ((process as unknown as { pkg?: unknown }).pkg != null) return true;
  return typeof __dirname === "string" && __dirname.startsWith("/snapshot");
}
