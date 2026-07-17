// test/hooks/build-stop-card.spec.ts
//
// The Stop hook's end-of-run review card, driven END TO END: `rescanAndCache` (TypeScript)
// writes the scan cache, then the REAL shell function the Stop hook calls
// (write_stop_review_card in common.sh) reads it back and appends the card.
//
// This used to copy the hook's jq filter into a TypeScript string literal and assert against
// that. It therefore proved only that the filter WE PASTED HERE matched the cache shape, and it
// could not see the shell at all. It duly stayed green while the function it claimed to cover
// resolved its paths from $HOME/.meetless, ignoring MEETLESS_HOME like nothing else in
// common.sh does. Sourcing the real function cannot drift that way (same argument as the
// classify_mcp_outcome bash twin).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rescanAndCache } from "../../src/commands/scan-context";
import { scanCachePath } from "../../src/lib/scanner/cache";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

// Source common.sh, stand in for the activation gate (which is what normally sets
// WORKSPACE_ID), then call the function exactly as stop.sh does.
const SCRIPT =
  'source "$COMMON_SH" >/dev/null 2>&1; WORKSPACE_ID="$WS"; write_stop_review_card "$SID" "$CARD_TS"';

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

interface Card {
  ts: string;
  event: string;
  session_id: string;
  items: Array<{ id: string; detail: string; source: string }>;
  total: number;
}

describe("write_stop_review_card (the Stop hook's real review-card writer)", () => {
  let repo: string;
  let home: string; // the OS-home convention: the `.meetless` segment is appended below

  // The shell's convention is the other one: MEETLESS_HOME *is* the `.meetless` dir.
  const stateRoot = () => join(home, ".meetless");
  const cardsPath = (ws: string) => join(stateRoot(), "workspaces", ws, "review-cards.jsonl");

  function runHookWriter(ws: string, sessionId: string, ts: string): void {
    execFileSync("bash", ["-c", SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        MEETLESS_HOME: stateRoot(),
        MEETLESS_DEBUG: "0",
        COMMON_SH,
        WS: ws,
        SID: sessionId,
        CARD_TS: ts,
      },
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-stop-repo-"));
    home = mkdtempSync(join(tmpdir(), "mla-stop-home-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "adr", "0007-x.md"),
      "# ADR-0007\nStatus: superseded by ADR-0012\n## Decision\nuse X\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "i"]);
    rescanAndCache({ cwd: repo, workspaceId: "ws1", home, now: () => "t" });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("appends a <=5-item card with id/detail/source and a total, read from the real scan cache", () => {
    expect(existsSync(scanCachePath("ws1", home))).toBe(true);

    runHookWriter("ws1", "s1", "2026-07-13T00:00:00Z");

    const lines = readFileSync(cardsPath("ws1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const card = JSON.parse(lines[0]) as Card;
    expect(card.event).toBe("review_card");
    expect(card.session_id).toBe("s1");
    expect(card.ts).toBe("2026-07-13T00:00:00Z");
    expect(card.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(card.items)).toBe(true);
    expect(card.items.length).toBeLessThanOrEqual(5);
    expect(card.items.length).toBeGreaterThanOrEqual(1);
    expect(typeof card.items[0].id).toBe("string");
    expect(card.items[0].id.length).toBeGreaterThan(0);
    expect(typeof card.items[0].detail).toBe("string");
    expect(card.items[0].source).toBe("docs/adr/0007-x.md");
  });

  // The regression. Before 2026-07-13 the function hard-coded $HOME/.meetless: it looked for the
  // cache in the operator's real home, found nothing there, and silently wrote no card at all,
  // while a relocated (MEETLESS_HOME) install had its cache sitting in plain sight. The assertion
  // above already goes red on that code (no file); this one also proves we did not merely move the
  // hard-coding, i.e. nothing is created under the real home for this fake workspace id.
  it("resolves the state root from MEETLESS_HOME, never from $HOME", () => {
    runHookWriter("ws1", "s1", "t");

    expect(existsSync(cardsPath("ws1"))).toBe(true);
    expect(existsSync(join(homedir(), ".meetless", "workspaces", "ws1"))).toBe(false);
  });

  it("appends (never truncates), so a second session's card joins the first", () => {
    runHookWriter("ws1", "s1", "t1");
    runHookWriter("ws1", "s2", "t2");

    const lines = readFileSync(cardsPath("ws1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as Card).session_id).toBe("s1");
    expect((JSON.parse(lines[1]) as Card).session_id).toBe("s2");
  });

  it("writes nothing and still succeeds when the workspace has no scan cache", () => {
    runHookWriter("ws-never-scanned", "s1", "t");

    expect(existsSync(cardsPath("ws-never-scanned"))).toBe(false);
  });
});
