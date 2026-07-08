import { runKb } from "../../src/commands/kb";

// Behavioral lock for `mla kb help` (and bare `mla kb`).
//
// The trap this closes: before this, `mla kb` / `mla kb help` / any unknown
// subcommand fell through runKb's switch to parseArgs(), which (a) required a
// workspace config and (b) advertised ONLY `summary`/`dump` -- hiding add,
// show, reingest, forget, purge, move, review, promote, and personal.
// The accurate subcommand catalog lived in a code comment users never read,
// and the grounding (trust) vs posture vs relationship model was nowhere on any
// help surface. That is exactly what made `kb add`/`kb promote`/`kb review` get
// mixed up.
//
// `pending` is deliberately NOT advertised: it survives only as a hidden,
// deprecated alias for `kb review --all` (the review verb is now overloaded to
// list the queue with no candidate id). The catalog must not surface it.
//
// Resolution: `mla kb` / `mla kb help` print the full KB catalog to STDOUT and
// exit 0 WITHOUT needing a workspace; an unknown subcommand prints the catalog
// to STDERR and exits 2.

describe("mla kb help", () => {
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

  const SHIPPED_SUBCOMMANDS = [
    "add",
    "show",
    "reingest",
    "forget",
    "purge",
    "move",
    "retime",
    "review",
    "promote",
    "personal",
    "summary",
    "dump",
  ];

  it.each([["help"], []])(
    "`mla kb %s` prints the full catalog to stdout and exits 0",
    async (...argv) => {
      const code = await runKb(argv as string[]);
      expect(code).toBe(0);
      const out = stdout();
      for (const sub of SHIPPED_SUBCOMMANDS) {
        expect(out).toMatch(new RegExp(`\\b${sub}\\b`));
      }
      // help must not leak onto the error stream.
      expect(stderr()).toBe("");
    },
  );

  // Doc-drift guard: the catalog MUST teach the post-cutover grounding model, not
  // the retired one. Grounding is decided by the TRUST axis (born PENDING;
  // `--provenance` advisory), NOT by provenance posture-defaulting. The old
  // "human_authored -> LIVE (grounded immediately)" text was a direct
  // contradiction of the born-PENDING rule taught later in the same block; it is
  // gone. Posture (SHADOW/LIVE) survives ONLY as the separate Personal-KB sharing
  // control (`kb promote`), and relationship review stays its own axis.
  it("kb catalog teaches trust-driven grounding, with posture and relationship review as separate axes", async () => {
    await runKb(["help"]);
    const out = stdout();
    expect(out).toMatch(/born PENDING/i);
    expect(out).toMatch(/advisory/i);
    // The dead provenance->grounding default must not reappear: no line may tie
    // human_authored to LIVE grounding.
    expect(out).not.toMatch(/human_authored\b[^\n]*LIVE/);
    expect(out).toMatch(/posture/i);
    expect(out).toMatch(/relationship/i);
  });

  it("unknown kb subcommand errors to stderr with the catalog and exits 2", async () => {
    const code = await runKb(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/frobnicate/);
    expect(stderr()).toMatch(/\badd\b/);
  });

  // Doc-drift guard: the temporal dimension. The point-in-time flag lives on
  // `mla ask --as-of`; it was removed from `kb show` when relationship edges (and
  // their valid-time windows) left the detail view for the Console lane. The
  // catalog MUST still teach the two temporal axes the same way it teaches posture
  // vs relationship review. valid-time = when a relation is TRUE in the world (what
  // --as-of filters on); observation-time = when Meetless recorded it (the
  // clock-trust axis). Conflating them is the bi-temporal footgun this catalog
  // exists to prevent.
  it("kb catalog keeps ask --as-of and teaches valid-time vs observation-time; drops kb show edge flags", async () => {
    await runKb(["help"]);
    const out = stdout();
    expect(out).toMatch(/mla ask --as-of/);
    expect(out).toMatch(/valid-time/i);
    expect(out).toMatch(/observation-time/i);
    // `--posture` was exclusively a `kb show` edge flag; it (with --as-of) left the
    // catalog when relationship edges moved to the Console relationships lane.
    expect(out).not.toMatch(/--posture/);
  });
});
