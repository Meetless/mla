#!/usr/bin/env node
// Measure what the redactor's entropy sweep costs a REAL captured corpus, and
// regenerate test/fixtures/redaction-path-corpus.json from the result.
//
// Why this is a committed script and not a scratch one-off. The "events" profile
// exists because of a number: the "full" bar eats thousands of path-shaped spans
// out of the hook event spool, which is the ledger `mla review` reasons over. A
// number that cannot be reproduced is an assertion, not evidence. Run this
// against any Claude Code project transcript directory to re-derive it:
//
//   node scripts/measure-redaction-corpus.js ~/.claude/projects/<project-dir> [transcriptLimit]
//
// It loads the LIVE redactor (transpiled from src/lib/redactor.ts at run time),
// not a hand-copied snapshot, so the number it prints is the number that ships.
//
// PRIVACY. This reads REAL session transcripts, so the fixture it writes is
// never allowed to contain their text. Every token is passed through a
// class-preserving substitution (see scrubInternal below) that keeps the shape
// the tests assert and destroys the content. "Read the diff before committing"
// used to be the control here; it is not one, and this file's history is the
// proof. Nothing selected out of a transcript reaches the fixture verbatim.
//
//   node scripts/measure-redaction-corpus.js --rewrite-fixture
//
// re-draws the substitution over the committed fixture without re-harvesting.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PKG_ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(PKG_ROOT, "test", "fixtures", "redaction-path-corpus.json");

// Load the real redactor by transpiling it, so this cannot drift from shipped
// behaviour the way a copied regex set would.
function loadRedactor() {
  const out = path.join(os.tmpdir(), `mla-redactor-measure-${process.pid}.cjs`);
  execFileSync(
    path.join(PKG_ROOT, "node_modules", ".bin", "esbuild"),
    [
      path.join(PKG_ROOT, "src", "lib", "redactor.ts"),
      "--format=cjs",
      "--platform=node",
      `--outfile=${out}`,
    ],
    { stdio: "inherit" },
  );
  const mod = require(out);
  fs.unlinkSync(out);
  return mod;
}

const { redact } = loadRedactor();

// The literal (non-entropy) half of the redactor, replicated here for ONE
// purpose: attribution. When a span disappears we need to know whether a
// credential pattern caught it or the entropy bar did, and only the entropy half
// is what the events profile changes.
const LITERALS = [
  /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*('[^']*'|"[^"]*"|\S+)/gim,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi,
  /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{20,}|lf_(?:sk|pk)_[A-Za-z0-9]{20,})\b/g,
  /\beyJ[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g,
  /(Set-)?Cookie:\s*[^\r\n]+/gi,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
];
const ENTROPY_TOKEN = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;

const literalsOnly = (s) => LITERALS.reduce((acc, p) => acc.replace(p, "[REDACTED]"), s);
const isPathShaped = (t) => t.includes("/") && /[a-z]/.test(t) && !/[A-Z]/.test(t);

/** Spans the ENTROPY bar removes under `profile` that the literals did not. */
function entropySpans(s, profile) {
  const spans = [];
  literalsOnly(s).replace(ENTROPY_TOKEN, (m) => {
    if (redact(m, profile) !== m) spans.push(m);
    return m;
  });
  return spans;
}

function readCorpus(dir, limit) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.f);

  const corpus = { command: [], assistantText: [] };
  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const blk of content) {
        if (
          blk?.type === "tool_use" &&
          blk?.name === "Bash" &&
          typeof blk?.input?.command === "string"
        ) {
          corpus.command.push(blk.input.command);
        } else if (
          blk?.type === "text" &&
          rec?.message?.role === "assistant" &&
          typeof blk.text === "string"
        ) {
          corpus.assistantText.push(blk.text);
        }
      }
    }
  }
  return { files, corpus };
}

// PRIVACY GATE. Two generations of this gate, and the second one is the point.
//
// v1 (the header above) was "read the diff before committing a regenerated
// fixture". That is not a control: nobody reads 1575 generated lines, and it
// showed. The fixture reached the public-mirror export staging carrying 11 real
// workspace/case/decision/profile cuids, this laptop's project layout and 107
// internal note paths, and the mirror's scrub gates matched exactly ONE of the
// 11; the other 10 were invisible to every gate and would have shipped.
//
// v2 (0.2.28) made the aliasing mechanical: cuids got numbered placeholders,
// `projects/meetless/` became `projects/example/`, and anything it could not
// alias was a hard stop. It was still an ENUMERATION of what to hide, so it hid
// exactly what its author had thought of. What it shipped anyway, because
// nobody had thought of them: 303 monorepo source paths, 135 notes/ slugs (left
// alone ON PURPOSE, see the v2 comment), 82 `internal/v1/*` route shapes, 42
// intel module paths, 24 private agent-skill names, and the Sentry org slug.
// A denylist cannot see a category nobody named.
//
// v3 (this) inverts it. The corpus asserts exactly three things, and every one
// of them is a statement about SHAPE:
//
//   1. every token survives the `events` profile   (needs: has "/", has
//      lowercase, has no uppercase)
//   2. the weighted occurrences total is unchanged (needs: the count, not the
//      key)
//   3. every token dies under the `full` profile   (needs: length >= 32,
//      >= 2 character classes, Shannon entropy >= 3.5)
//
// Nothing reads a token's TEXT. So no token needs to keep its text. Every
// alphanumeric character is replaced with a deterministic pseudorandom
// character OF THE SAME CLASS, and separators (`/ _ - + =`) stay exactly where
// they are. Length, slash count, class composition and path shape are preserved
// by construction; entropy is preserved-or-raised, which is the safe direction
// for bar 3. Then each result is checked against the LIVE redactor, so a token
// that lands on the wrong side of either bar (a substitution can accidentally
// spell `sk-`, `hf_`, `xox...`, which the literal patterns would then eat under
// every profile) is re-drawn rather than written.
//
// The security property is the one that matters here: this cannot leak a
// category nobody anticipated, because nothing survives verbatim. It is
// de-identification of a shape corpus, not encryption; the mapping is a
// keyed-by-content hash so regenerating produces a stable diff.
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGIT = "0123456789";
const SALT = "mla-redaction-path-corpus/v3";

function keystream(seed, n) {
  const out = [];
  let block = require("crypto").createHash("sha256").update(seed).digest();
  while (out.length < n) {
    out.push(...block);
    block = require("crypto").createHash("sha256").update(block).digest();
  }
  return out;
}

/** Same length, same class per position, same separators. Different text. */
function synthesize(token, attempt) {
  const ks = keystream(`${SALT} ${attempt} ${token}`, token.length);
  let out = "";
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i];
    if (c >= "a" && c <= "z") out += LOWER[ks[i] % 26];
    else if (c >= "A" && c <= "Z") out += UPPER[ks[i] % 26];
    else if (c >= "0" && c <= "9") out += DIGIT[ks[i] % 10];
    else out += c;
  }
  return out;
}

function scrubInternal(entries) {
  const out = [];
  const seen = new Set();

  for (const [t, n] of entries) {
    let s = null;
    for (let attempt = 0; attempt < 64 && s === null; attempt += 1) {
      const c = synthesize(t, attempt);
      // The corpus only means anything if every token still sits on the same
      // side of both bars it was selected for. A substitution that moves a
      // token is a bug in the substitution, not a fact about the redactor.
      if (seen.has(c)) continue;
      if (redact(c, "events") !== c) continue;
      if (redact(c, "full") === c) continue;
      s = c;
    }
    if (s === null) throw new Error(`could not synthesize a shape-equivalent token for a ${t.length}-char input after 64 draws`);
    seen.add(s);
    out.push([s, n]);
  }

  // Belt and braces. After a total substitution this should be vacuous, and
  // that is the point: it is an assertion that v3 did what it claims, not a
  // filter that anything is expected to trip. If it ever fires, the
  // substitution stopped being total and the enumeration problem is back.
  //
  // The operator is derived at run time, never spelled. An earlier draft
  // hardcoded this laptop's username and the dogfood domain, which published
  // two internal identifiers inside the very check that exists to catch them.
  const operator = [os.userInfo().username, path.basename(os.homedir())].filter((s) => s && s.length > 2);
  const residual = out
    .map(([t]) => t)
    .filter(
      (t) =>
        /\/users\/|meetless|notes\/\d{8}|internal\/v\d|apps\/(control|connector|worker|console|relay)\/|intel\/app\/|claude\/skills\//i.test(t) ||
        operator.some((u) => t.includes(u)) ||
        /\bc[a-z0-9]{24}\b/.test(t),
    );
  if (residual.length) {
    throw new Error(`refusing to write: ${residual.length} token(s) still carry an internal identifier after substitution:\n  ${residual.slice(0, 20).join("\n  ")}`);
  }
  return out;
}

const FIXTURE_COMMENT =
  "Generated by scripts/measure-redaction-corpus.js. Every token is a path-shaped span the 'full' entropy bar destroys and the 'events' profile preserves. The TEXT is synthetic: each token is a class-preserving substitution of a real captured span (same length, same separators, same character classes, entropy preserved-or-raised), because these tests assert shape and nothing reads the text. Do not 'restore' readability here; the readable version leaked internal paths for two releases.";

function writeFixture({ transcripts, entries, totalOccurrences }) {
  const sorted = scrubInternal(entries).sort((a, b) => a[0].localeCompare(b[0]));
  fs.writeFileSync(
    FIXTURE,
    `${JSON.stringify(
      {
        _comment: FIXTURE_COMMENT,
        transcripts,
        distinctTokens: sorted.length,
        totalOccurrences,
        tokens: Object.fromEntries(sorted),
      },
      null,
      1,
    )}\n`,
  );
  console.error(`wrote ${FIXTURE}: ${sorted.length} distinct, ${totalOccurrences} occurrences`);
}

// Re-run the substitution over the COMMITTED fixture. The corpus is a harvest
// from 40 real transcripts that no longer reproduce byte-for-byte, so
// "regenerate it" is not available as a remedy once a privacy bug is found in
// a fixture that already shipped. This is: same counts, same shapes, new text.
function rewriteFixture() {
  const cur = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const entries = Object.entries(cur.tokens);
  const occurrences = entries.reduce((sum, [, n]) => sum + n, 0);
  if (occurrences !== cur.totalOccurrences) {
    throw new Error(`fixture is already inconsistent: weights sum to ${occurrences}, header says ${cur.totalOccurrences}`);
  }
  writeFixture({ transcripts: cur.transcripts, entries, totalOccurrences: cur.totalOccurrences });
}

function main() {
  if (process.argv.includes("--rewrite-fixture")) return rewriteFixture();

  const dir = process.argv[2];
  const limit = Number(process.argv[3] || 40);
  if (!dir) {
    console.error("usage: measure-redaction-corpus.js <transcriptDir> [transcriptLimit]");
    console.error("       measure-redaction-corpus.js --rewrite-fixture");
    process.exit(2);
  }

  const { files, corpus } = readCorpus(dir, limit);
  const tokens = new Map();
  const report = {};

  for (const [field, items] of Object.entries(corpus)) {
    const r = {
      items: items.length,
      itemsWithCredentialPattern: 0,
      itemsAlteredFull: 0,
      itemsAlteredEvents: 0,
      pathShapedEatenFull: 0,
      pathShapedEatenEvents: 0,
      otherEatenFull: 0,
      otherEatenEvents: 0,
    };
    for (const s of items) {
      if (literalsOnly(s) !== s) r.itemsWithCredentialPattern += 1;
      if (redact(s, "full") !== s) r.itemsAlteredFull += 1;
      if (redact(s, "events") !== s) r.itemsAlteredEvents += 1;
      for (const tok of entropySpans(s, "full")) {
        if (isPathShaped(tok)) {
          r.pathShapedEatenFull += 1;
          tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
        } else r.otherEatenFull += 1;
      }
      for (const tok of entropySpans(s, "events")) {
        if (isPathShaped(tok)) r.pathShapedEatenEvents += 1;
        else r.otherEatenEvents += 1;
      }
    }
    report[field] = r;
  }

  const totals = Object.values(report).reduce(
    (a, r) => ({
      pathShapedEatenFull: a.pathShapedEatenFull + r.pathShapedEatenFull,
      pathShapedEatenEvents: a.pathShapedEatenEvents + r.pathShapedEatenEvents,
      otherEatenFull: a.otherEatenFull + r.otherEatenFull,
      otherEatenEvents: a.otherEatenEvents + r.otherEatenEvents,
    }),
    { pathShapedEatenFull: 0, pathShapedEatenEvents: 0, otherEatenFull: 0, otherEatenEvents: 0 },
  );

  console.log(JSON.stringify({ transcripts: files.length, report, totals }, null, 2));

  if (process.argv.includes("--write-fixture")) {
    writeFixture({
      transcripts: files.length,
      entries: [...tokens.entries()],
      totalOccurrences: totals.pathShapedEatenFull,
    });
  }
}

main();
