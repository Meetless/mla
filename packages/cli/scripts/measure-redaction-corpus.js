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
// PRIVACY. The fixture it writes contains only tokens that are BOTH path-shaped
// (slash, lowercase, no uppercase) AND survived the literal credential patterns.
// In practice that is source paths, node_modules paths and URL path fragments.
// Read the diff before committing a regenerated fixture anyway: this reads real
// session transcripts, and "path-shaped" is a signature, not a guarantee.

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

// PRIVACY GATE (added 0.2.28). The header above used to say "read the diff
// before committing a regenerated fixture". That is not a control: nobody reads
// 1575 generated lines, and it showed. The fixture reached the public-mirror
// export staging carrying 11 real workspace/case/decision/profile cuids, this
// laptop's project layout and 107 internal note paths, and the mirror's scrub
// gates matched exactly ONE of the 11; the other 10 were invisible to every
// gate and would have shipped.
//
// So the aliasing is mechanical now, and anything this function does not know
// how to alias is a HARD STOP rather than a silent write. Note slugs are left
// alone deliberately: `src/lib/*.ts` comments already cite notes/*.md paths in
// the published mirror, so they are a pre-existing disclosure to settle on its
// own terms, not something to quietly change under a release.
function scrubInternal(entries) {
  const CUID = /\bc[a-z0-9]{24}\b/g;
  const isSynthetic = (c) => /^(cm|cu|c00)example/.test(c);

  const real = [...new Set(entries.flatMap(([t]) => t.match(CUID) || []))].filter((c) => !isSynthetic(c)).sort();
  const alias = new Map(real.map((c, i) => [c, `cmexample${String(i).padStart(2, "0")}a1b2c3d4e5f6g7`]));
  for (const [from, to] of alias) {
    if (from.length !== to.length) throw new Error(`alias length drift: ${from} -> ${to}`);
  }

  const scrub = (t) => {
    let s = t.replace(/projects\/meetless\//g, "projects/example/").replace(/projects\/example\/meetless\//g, "projects/example/example/");
    for (const [from, to] of alias) s = s.split(from).join(to);
    return s;
  };

  const out = [];
  const seen = new Set();
  for (const [t, n] of entries) {
    const s = scrub(t);
    if (seen.has(s)) throw new Error(`alias collision: ${t} and an earlier token both became ${s}`);
    seen.add(s);
    // The corpus only means anything if every token still sits on the same side
    // of both bars it was selected for. An alias that moves a token is a bug in
    // the alias, not a fact about the redactor.
    if (redact(s, "events") !== s) throw new Error(`alias broke the events verdict: ${t} -> ${s}`);
    if (redact(s, "full") === s) throw new Error(`alias broke the full verdict: ${t} -> ${s}`);
    out.push([s, n]);
  }

  // The operator is derived at run time, never spelled. The first draft of this
  // guard hardcoded this laptop's username and the dogfood domain, which
  // published two internal identifiers inside the very check that exists to
  // catch them, in the release whose headline is that the fixture stopped
  // carrying them. Deriving it also means the check works for whoever
  // regenerates the fixture next, instead of only for the person who wrote it.
  //
  // Dogfood hostnames are deliberately not checked here. The mirror export's
  // gate 3 greps the whole staging tree for them and is the authority on
  // publication; what THAT gate cannot see is opaque identifiers, which is
  // exactly what the cuid and operator checks below cover.
  const operator = [os.userInfo().username, path.basename(os.homedir())].filter((s) => s && s.length > 2);
  const residual = out
    .map(([t]) => t)
    .filter(
      (t) =>
        /\/Users\/|projects\/meetless\//.test(t) ||
        operator.some((u) => t.includes(u)) ||
        (t.match(CUID) || []).some((c) => !isSynthetic(c)),
    );
  if (residual.length) {
    throw new Error(`refusing to write: ${residual.length} token(s) still carry an internal identifier this script cannot alias:\n  ${residual.slice(0, 20).join("\n  ")}`);
  }
  return out;
}

function main() {
  const dir = process.argv[2];
  const limit = Number(process.argv[3] || 40);
  if (!dir) {
    console.error("usage: measure-redaction-corpus.js <transcriptDir> [transcriptLimit]");
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
    const sorted = scrubInternal([...tokens.entries()].sort((a, b) => a[0].localeCompare(b[0])));
    fs.writeFileSync(
      FIXTURE,
      `${JSON.stringify(
        {
          _comment:
            "Generated by scripts/measure-redaction-corpus.js --write-fixture. Every token here is a path-shaped span the 'full' entropy bar destroys and the 'events' profile preserves. Regenerate only with a deliberate re-measurement; read the diff first.",
          transcripts: files.length,
          distinctTokens: sorted.length,
          totalOccurrences: totals.pathShapedEatenFull,
          tokens: Object.fromEntries(sorted),
        },
        null,
        1,
      )}\n`,
    );
    console.error(`wrote ${FIXTURE}: ${sorted.length} distinct, ${totals.pathShapedEatenFull} occurrences`);
  }
}

main();
