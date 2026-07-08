import { dispatch } from "../../src/cli";

// Behavioral lock for `mla help`.
//
// The trap this closes: before `help` was wired, `mla help` fell through
// the dispatcher's switch to the `default` arm, which printed
// "Unknown command: help" to STDERR and exited 2. An operator typing the
// git/npm/docker-style `mla help` out of muscle memory got an error
// instead of the usage text.
//
// Resolution: `help` is an alias for `--help`/`-h` — it prints the full
// USAGE block to STDOUT and exits 0. These tests assert the rendered
// behavior (what stream, what content, what exit code), not just that a
// branch exists.

describe("mla help", () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const stdout = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const stderr = () => errSpy.mock.calls.map((c) => String(c[0])).join("\n");

  // Every entry point into the usage screen must behave identically.
  it.each([["help"], ["--help"], ["-h"], []])(
    "`mla %s` prints usage to stdout and exits 0",
    async (...argv) => {
      const code = await dispatch(argv as string[]);
      expect(code).toBe(0);
      expect(stdout()).toMatch(/mla: Meetless Agent CLI/);
      expect(stdout()).toMatch(/usage:/);
      // Help must not leak onto the error stream.
      expect(stderr()).toBe("");
    },
  );

  it("`mla help` does not hit the unknown-command error path", async () => {
    await dispatch(["help"]);
    expect(stderr()).not.toMatch(/Unknown command/);
  });

  it("usage text advertises the `mla help` command", async () => {
    await dispatch(["help"]);
    expect(stdout()).toMatch(/^\s*mla help\s*$/m);
  });

  // Doc-drift guard: `mla flush` gained --gc (drain then reap) and
  // --reap-only (reap without drain) when the stale-session reaper landed,
  // but the usage line still advertised only [--all|--session] [--quiet].
  // Shipped-but-undocumented flags are invisible to operators; lock them
  // into the help screen so the next flag addition can't silently drop off.
  it("usage text documents the flush --gc and --reap-only flags", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla flush[^\n]*--gc/);
    expect(out).toMatch(/--reap-only/);
  });

  // Doc-drift guard: the born-PENDING rule is the single most-confused KB fact
  // after the two-axis governed cutover. Posture (LIVE/SHADOW by provenance) is
  // GONE: the server derives trust from the capture path, so every `kb add`
  // lands reviewOutcome=PENDING regardless of --provenance, and --provenance is
  // now advisory. The help screen MUST teach this or readers (human and agent
  // alike) keep reaching for the dead posture flag.
  it("usage text documents that kb add is born PENDING and --provenance is advisory", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/born PENDING/i);
    expect(out).toMatch(/advisory/i);
    // The dead posture override must not be advertised under kb add anymore.
    expect(out).not.toMatch(/Override with --posture/);
  });

  // Doc-drift guard: `kb promote` (formerly `kb share`) and `kb personal` are
  // shipped + routed in kb.ts but were absent from the usage screen, making them
  // undiscoverable and feeding the wrong "share is how you ground a doc" mental
  // model. The verb was renamed promote precisely to kill that misread; the
  // catalog must advertise the new name.
  it("usage text advertises kb promote and kb personal", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla kb promote/);
    expect(out).toMatch(/mla kb personal/);
  });

  // Doc-drift guard: the as-of (valid-time) surface. `ask --as-of` answers
  // point-in-time questions and MUST stay advertised. `kb show --as-of` was removed
  // when relationship edges (and their valid-time windows) left the detail view for
  // the Console lane, so the usage screen must not resurrect `--posture` / `--as-of`
  // as `kb show` flags.
  it("usage text keeps ask --as-of for point-in-time and drops the removed kb show edge flags", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla ask[\s\S]{0,200}--as-of/);
    expect(out).toMatch(/point-in-time/i);
    // `--posture` was exclusively a `kb show` edge flag; its removal is the signal
    // the edge lane left the detail view.
    expect(out).not.toMatch(/--posture/);
  });

  // Doc-drift guard: `mla uninstall` removes the local Meetless footprint. The
  // usage screen MUST advertise it so operators know how to cleanly remove the
  // CLI without hunting for files to delete manually.
  it("usage text advertises the `mla uninstall` command", async () => {
    await dispatch(["help"]);
    expect(stdout()).toMatch(/mla uninstall/);
  });

  // Doc-drift guard: `mla graph` (alias `mla cg`) is the relationship axis's own
  // home (notes/20260608-mla-ml-generalization-review.md, Q1). The usage screen
  // MUST advertise it AND keep teaching that it is the relationship axis, distinct
  // from the document/posture axis under `mla kb`, or the whole reason the command
  // exists (un-burying the coordination graph) is invisible to operators.
  it("usage text advertises the mla graph relationship surface and its `cg` alias", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla graph review/);
    expect(out).toMatch(/mla graph pending/);
    expect(out).toMatch(/mla cg/);
    expect(out).toMatch(/mla graph[\s\S]{0,400}relationship/i);
  });

  // Doc-drift guard: `mla turn [N]` is the per-turn assist recap (Layer B of
  // notes/20260609-mla-per-turn-assist-recap-plan.md), the per-turn analog of
  // `mla stats`. The usage screen MUST advertise it AND name the `mla stats --turn`
  // alias, or the feature An asked for ("did mla run + help this turn?") is
  // undiscoverable from the surface he framed it against.
  it("usage text advertises mla turn and its `stats --turn` alias", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla turn \[N\]/);
    expect(out).toMatch(/mla turn[\s\S]{0,400}stats --turn/);
  });

  // Doc-drift guard: `mla context advisory` lists the untracked agent-memory rules
  // discovered by the cold-start scan (machine_inferred, NEVER auto-injected; review
  // only). It is a real, routed subcommand but was absent from the catalog, so the
  // whole advisory surface was undiscoverable from `mla --help`. The usage screen MUST
  // advertise it AND keep teaching that the rules are advisory/not-injected, or
  // operators never learn the review-only worklist exists.
  it("usage text advertises mla context advisory as a review-only surface", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla context advisory/);
    expect(out).toMatch(/mla context advisory[\s\S]{0,400}(advisory|not injected|review)/i);
  });

  // Doc-drift guard: `mla activate --bootstrap <fast|agentic>` after Phase 2
  // consolidation. `agentic` is deprecated (still emits the static scout mission) and
  // the help screen must steer operators to the consolidated `/mla onboard` flow. A
  // shipped-but-undocumented tier flag is invisible to operators; lock it into help.
  it("usage text advertises mla activate --bootstrap and steers to /mla onboard", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla activate --bootstrap/);
    expect(out).toMatch(/mla activate --bootstrap[\s\S]{0,400}(fast|agentic)/i);
    expect(out).toMatch(/mla activate --bootstrap[\s\S]{0,400}(scout|onboard)/i);
  });

  // Doc-drift guard: `mla scan` is the operator-facing rescan lever (thin alias to the
  // `_internal scan-context` routine). It MUST be advertised because the degraded-cache
  // delivery markers (scanner/render.ts) tell the agent to "run mla scan" by name; a
  // marker pointing at an undiscoverable command is a broken self-heal instruction.
  it("usage text advertises the `mla scan` rescan lever named by the delivery markers", async () => {
    await dispatch(["help"]);
    const out = stdout();
    expect(out).toMatch(/^\s*mla scan\s*$/m);
    expect(out).toMatch(/mla scan[\s\S]{0,400}(rebuild|rescan|refresh)/i);
    expect(out).toMatch(/mla scan[\s\S]{0,400}cache/i);
  });

  // Doc-drift guard: post rules-store cutover, `mla rules add` writes to the BACKEND rule
  // store (the workspace source of truth), NOT the local `.meetless/rules.md`. The old
  // help misdescribed it as a local-file writer "effective locally; commit + push to
  // share" (fixed once for the file banner in 4ab64abc, but the help block was missed).
  // The screen MUST teach the backend authority + the `mla scan` refresh, and MUST NOT
  // resurrect the local-file authoring model, or operators keep hand-editing a mirror.
  it("usage text teaches rules add writes the backend store, not a local file", async () => {
    await dispatch(["help"]);
    const out = stdout();
    // The help formatter word-wraps the description across indented lines, so a phrase
    // like "backend rule store" can straddle a line break. Collapse whitespace before
    // matching so the guard asserts the wording, not the wrap column.
    const rulesAdd = (out.match(/mla rules add[\s\S]{0,600}/)?.[0] ?? "").replace(/\s+/g, " ");
    expect(rulesAdd).toMatch(/backend rule store/i);
    expect(rulesAdd).toMatch(/mla scan/);
    // The retired local-authority framing must not reappear under `rules add`.
    expect(rulesAdd).not.toMatch(/effective locally/i);
    expect(rulesAdd).not.toMatch(/to \.meetless\/rules\.md/i);
  });

  // Doc-drift guard: `mla rules remove` is unsupported with the backend store (it errors
  // and points at `revoke`). The old help advertised a working local delete from
  // `.meetless/rules.md`; that is doubly wrong. The screen MUST mark it unsupported and
  // steer to `mla rules revoke`, or operators reach for a delete that never happens.
  it("usage text marks rules remove unsupported and steers to revoke", async () => {
    await dispatch(["help"]);
    const out = stdout();
    const rulesRemove = (out.match(/mla rules remove[\s\S]{0,400}/)?.[0] ?? "").replace(/\s+/g, " ");
    expect(rulesRemove).toMatch(/unsupported/i);
    expect(rulesRemove).toMatch(/mla rules revoke/);
  });
});
