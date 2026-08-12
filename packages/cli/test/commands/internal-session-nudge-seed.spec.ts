import type { CliConfig } from "../../src/lib/config";
import { NotActivatedError, type WorkspaceContext } from "../../src/lib/workspace";
import { runInternalSessionNudge } from "../../src/commands/internal-session-nudge";
import type { SeedOutcome } from "../../src/lib/enrichment/deterministic-seed";
import type { OnboardingOfferInput } from "../../src/lib/analytics/onboarding-offer";

// The SessionStart nudge, after P0-1 + P0-3.
//
// Before this, the nudge's only move in a never-onboarded workspace was to ask a human to type
// `/mla onboard`. Measured over four days in production that converted nobody, and we could not
// tell whether it was being ignored or never shown, because it emitted no event.
//
// Now the same LEVEL trigger does the deterministic half itself (there is no hook-driven bind to
// hang it on: hooks gate on an existing `.meetless.json` and only `mla activate` writes one, so
// SessionStart is the ONLY trigger that reaches a workspace already past activation), and it
// emits exactly one row so the funnel is countable.
//
// The invariant that outranks all of it: a nudge is not a gate. Nothing here may fail a session
// start, and nothing here may make one wait on a network fault.

function loggedInCfg(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "ml_at_x",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    actorUserId: "u1",
    auth: {
      mode: "user-token",
      accessToken: "ml_at_x",
      refreshToken: "ml_rt_x",
      accessExpiresAt: "2999-01-01T00:00:00.000Z",
      refreshExpiresAt: "2999-02-01T00:00:00.000Z",
      sessionId: "s1",
      user: { id: "u1", displayName: "An", email: null, role: "OWNER" },
    },
  };
}

function activeCtx(): WorkspaceContext {
  return {
    workspaceId: "ws_marker_123",
    workspaceName: "An's Workspace",
    markerPath: "/repo/.meetless.json",
    markerDir: "/repo",
  };
}

function outcome(over: Partial<SeedOutcome> = {}): SeedOutcome {
  return {
    enumerated: true,
    candidates: 0,
    ingested: 0,
    noop: 0,
    failed: 0,
    unchanged: 0,
    shared: 0,
    redundant: 0,
    blocked: 0,
    retracted: 0,
    remaining: 0,
    skipped: [],
    unretractable: [],
    ...over,
  };
}

interface Harness {
  out: string[];
  offers: OnboardingOfferInput[];
  seeded: string[];
  deps: Parameters<typeof runInternalSessionNudge>[1];
}

function harness(over: Record<string, unknown> = {}): Harness {
  const out: string[] = [];
  const offers: OnboardingOfferInput[] = [];
  const seeded: string[] = [];
  const deps = {
    readConfig: () => loggedInCfg(),
    resolveWorkspaceContext: () => activeCtx(),
    isGitRepo: () => true,
    log: (m: string) => out.push(m),
    env: {},
    workspaceEverOnboarded: async () => false,
    seedWorkspace: async (cwd: string) => {
      seeded.push(cwd);
      // The happy path is add AND share: a document that lands without reaching WORKSPACE scope
      // is invisible to the team, so the fixture must set both or it is not a success case.
      return outcome({ candidates: 2, ingested: 2, shared: 2 });
    },
    emitOffer: (input: OnboardingOfferInput) => {
      offers.push(input);
    },
    ...over,
  };
  return { out, offers, seeded, deps: deps as Harness["deps"] };
}

function injected(line: string): string {
  return JSON.parse(line).hookSpecificOutput.additionalContext;
}

describe("the nudge seeds a never-onboarded workspace", () => {
  it("runs the deterministic seed instead of only asking a human to", async () => {
    const h = harness();
    const code = await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(code).toBe(0);
    expect(h.seeded).toEqual(["/repo"]);
  });

  it("tells the agent the corpus now ANSWERS, rather than repeating the chore", async () => {
    const h = harness();
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    // The point of the seed is that this workspace stopped being un-answerable.
    expect(msg).toMatch(/2 agent-instruction file/i);
    expect(msg).toMatch(/retrieve_knowledge/);
    // The trust boundary must stay visible: nothing was accepted.
    expect(msg).toMatch(/PENDING|provisional/i);
    // And onboarding must be reframed as ENRICHMENT, not as the doorway it used to be.
    expect(msg).toMatch(/\/mla onboard/);
  });

  it("still says the corpus is empty when the repo has no instruction files to seed", async () => {
    const h = harness({ seedWorkspace: async () => outcome() });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).toMatch(/never been seeded|no indexed|returns nothing/i);
    expect(msg).toMatch(/\/mla onboard/);
  });
});

// The synchronization must NOT depend on the remote onboarding probe.
//
// Those are two different questions answered by two different systems: "are this checkout's
// instruction files in the corpus" is a LOCAL receipt-versus-scan diff, while "has this
// workspace ever run agentic onboarding" is a remote lookup. Coupling them meant a slow intel
// cost us the corpus, not just the sentence, and the probe's own 2500ms budget was justified in
// comment by "it only decides whether to print one paragraph" -- true when it was written, false
// once the seed hung off it. Raising that timeout would have treated the symptom; the fix is
// that the probe no longer gates anything but copy.
describe("synchronization is independent of the onboarding probe", () => {
  it("SYNCS when the probe says the workspace was already onboarded", async () => {
    const h = harness({ workspaceEverOnboarded: async () => true });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.seeded).toEqual(["/repo"]);
    // Nothing to say: an onboarded workspace is not owed an onboarding offer.
    expect(h.out).toHaveLength(0);
    expect(h.offers).toHaveLength(0);
  });

  it("SYNCS when the probe times out and returns unknown", async () => {
    const h = harness({ workspaceEverOnboarded: async () => null });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.seeded).toEqual(["/repo"]);
    expect(h.out).toHaveLength(0);
  });

  it("SYNCS when the probe THROWS", async () => {
    const h = harness({
      workspaceEverOnboarded: async () => {
        throw new Error("intel unreachable");
      },
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(code).toBe(0);
    expect(h.seeded).toEqual(["/repo"]);
  });

  it("adds a supported file AFTER a full onboarding run and still synchronizes it", async () => {
    // The regression this pins: once `/mla onboard` has run, the probe answers true forever, so
    // a probe-gated sync would never pick up a CLAUDE.md added next week.
    const synced: SeedOutcome[] = [];
    const h = harness({
      workspaceEverOnboarded: async () => true,
      seedWorkspace: async () => {
        const o = outcome({ candidates: 1, ingested: 1, shared: 1 });
        synced.push(o);
        return o;
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(synced).toHaveLength(1);
    expect(synced[0].shared).toBe(1);
  });
});

// P2-6: the SECOND teammate.
//
// Their sync ingests their own private copies, discovers a teammate already shares each file
// (409), and tombstones them. So `ingested` is non-zero while NOTHING durable was added by them,
// and the naive count (ingested + noop) would tell teammate two "Meetless just indexed 2
// agent-instruction files and shared them with the workspace" about two documents that no longer
// exist. That is the same class of false claim as the activation card promising delivery it
// could not perform, and it lands on a teammate's very first session.
describe("the second teammate gets an honest receipt, not the seeder's message", () => {
  it("does NOT claim the teammate indexed files that were retracted as redundant", async () => {
    const h = harness({
      seedWorkspace: async () => outcome({ candidates: 2, ingested: 2, redundant: 2 }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).not.toMatch(/just indexed 2/i);
  });

  it("tells them the files are ALREADY shared by a teammate and are retrievable now", async () => {
    const h = harness({
      seedWorkspace: async () => outcome({ candidates: 2, ingested: 2, redundant: 2 }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).toMatch(/teammate|already/i);
    expect(msg).toMatch(/retrievable|retrieve_knowledge/i);
    // Still the enrichment pointer: a shared corpus of instruction files is not a shared corpus
    // of decisions.
    expect(msg).toMatch(/\/mla onboard/);
  });

  it("reports the workspace as seeded, not dark, so the funnel does not count it as a failure", async () => {
    const h = harness({
      seedWorkspace: async () => outcome({ candidates: 2, ingested: 2, redundant: 2 }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.offers[0].corpusState).toBe("seeded_prior");
    expect(h.offers[0].seededDocuments).toBe(0);
    expect(h.offers[0].instructionFilesPresent).toBe(2);
  });

  it("still reports a genuine mixed run honestly", async () => {
    // One new file of ours plus one a teammate already owns: we DID add one.
    const h = harness({
      seedWorkspace: async () => outcome({ candidates: 2, ingested: 2, redundant: 1, shared: 1 }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(injected(h.out[0])).toMatch(/just indexed 1 agent-instruction file\b/i);
  });

  // Measured live: a teammate whose receipt was lost re-adds, kb-add dedups onto their own
  // TOMBSTONED copy, and every promote fails. `ingested + noop` is 2 and NOTHING was shared, so
  // counting the message off the add alone claimed two indexed files on a run that achieved
  // nothing. The count must follow what was SHARED, which is the only durable outcome here.
  it("claims nothing when every document landed but none could be shared", async () => {
    const h = harness({
      seedWorkspace: async () => outcome({ candidates: 2, noop: 2, failed: 2 }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).not.toMatch(/just indexed/i);
    expect(h.offers[0].seededDocuments).toBe(0);
    expect(h.offers[0].seedFailed).toBe(true);
  });
});

// PENDING material is INDEXED and RETRIEVABLE. It is not "governed".
//
// "Governed" is the authority word in this product: it is what a human review confers, and it is
// the thing the seed deliberately does NOT do. Using it for born-PENDING material told the agent
// the corpus carried team authority it has not been granted, which is the exact trust boundary
// the seed is careful to preserve everywhere else.
describe("copy never claims PENDING material is governed", () => {
  it("says INDEXED and RETRIEVABLE, not governed, when files are already synchronized", async () => {
    const h = harness({ seedWorkspace: async () => outcome({ unchanged: 3 }) });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).not.toMatch(/governed/i);
    expect(msg).toMatch(/indexed|retrievable/i);
    expect(msg).toMatch(/PENDING/);
  });

  it("says INDEXED, not governed, on the freshly-seeded message too", async () => {
    const h = harness();
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    const msg = injected(h.out[0]);
    expect(msg).not.toMatch(/governed/i);
    expect(msg).toMatch(/indexed/i);
  });

  it("still points at the human review path, which is where authority actually comes from", async () => {
    const h = harness({ seedWorkspace: async () => outcome({ unchanged: 3 }) });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(injected(h.out[0])).toMatch(/review|accepted/i);
  });
});

describe("the nudge never seeds a workspace that does not need it", () => {
  it("seeds NOTHING in a repo with no marker; there is no workspace to seed into", async () => {
    const h = harness({
      resolveWorkspaceContext: () => {
        throw new NotActivatedError("/repo");
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.seeded).toEqual([]);
    expect(injected(h.out[0])).toMatch(/installed but inactive/i);
  });

  it("seeds NOTHING when signed out; there is no credential to write with", async () => {
    const h = harness({
      readConfig: () => ({ ...loggedInCfg(), auth: { mode: "none" as const } }),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.seeded).toEqual([]);
    expect(injected(h.out[0])).toMatch(/mla login/);
  });
});

describe("a nudge is not a gate", () => {
  it("never fails the session start when the seed throws", async () => {
    const h = harness({
      seedWorkspace: async () => {
        throw new Error("intel unreachable");
      },
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(code).toBe(0);
    // The workspace is still dark, so the ask still has to be made.
    expect(injected(h.out[0])).toMatch(/\/mla onboard/);
  });

  it("never fails the session start when telemetry throws", async () => {
    const h = harness({
      emitOffer: () => {
        throw new Error("spool is read-only");
      },
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
  });
});

describe("the offer is countable (P0-3)", () => {
  it("emits exactly one offer row, naming the surface", async () => {
    const h = harness();
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.offers).toHaveLength(1);
    expect(h.offers[0].surface).toBe("session_start");
  });

  it("separates a workspace we just seeded from one that is still dark", async () => {
    const seededRun = harness();
    await runInternalSessionNudge(["--cwd", "/repo"], seededRun.deps);
    expect(seededRun.offers[0]).toMatchObject({ corpusState: "seeded", seededDocuments: 2 });

    const darkRun = harness({ seedWorkspace: async () => outcome() });
    await runInternalSessionNudge(["--cwd", "/repo"], darkRun.deps);
    expect(darkRun.offers[0]).toMatchObject({ corpusState: "dark", seededDocuments: 0 });
  });

  it("reports a workspace already seeded on a previous session as seeded_prior", async () => {
    const h = harness({ seedWorkspace: async () => outcome({ unchanged: 3 }) });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.offers[0]).toMatchObject({ corpusState: "seeded_prior", instructionFilesPresent: 3 });
  });

  it("marks a FAILED seed rather than letting it read as a repo with nothing to seed", async () => {
    // These two states look identical in `seeded_documents: 0` and demand opposite fixes: one is
    // a repo that wrote nothing down, the other is an intel we cannot reach.
    const h = harness({ seedWorkspace: async () => outcome({ candidates: 2, failed: 2 }) });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.offers[0]).toMatchObject({ seedFailed: true, corpusState: "dark" });
  });

  it("marks a seed that THREW as failed too", async () => {
    const h = harness({
      seedWorkspace: async () => {
        throw new Error("boom");
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], h.deps);
    expect(h.offers[0]).toMatchObject({ seedFailed: true, corpusState: "dark" });
  });
});
