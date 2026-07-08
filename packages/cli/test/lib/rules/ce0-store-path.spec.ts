import * as path from "path";

import { defaultCe0StorePath } from "../../../src/lib/rules/ce0-store";
import { defaultCe0StorePath as evidenceReExport } from "../../../src/commands/evidence";
import { HOME } from "../../../src/lib/config";

// Latency lever A, Phase 3 (notes/20260615-...-consolidated-proposal.md): the CE0 store
// path resolver now lives on the LEAN ce0-store module instead of the heavy evidence
// command module. evidence.ts top-level pulls analytics/recorder, analytics/store,
// observability, and the ce0-evidence/telemetry graph (~100ms cold). The PreToolUse deny
// hot path (internal-pretool-observe -> pretool-entry) only needs the store path + the
// native store, so importing the resolver from ce0-store severs that whole graph from the
// hot path. This spec pins (1) the resolver is exported from ce0-store and resolves to the
// canonical per-machine location under the Meetless home, and (2) the evidence.ts symbol is
// preserved as a re-export so the four non-hot-path consumers (evidence's own ce0-emit,
// doctor, rules, internal-evidence-hooks) keep importing it from `./evidence` unchanged.
describe("defaultCe0StorePath (relocated onto the lean ce0-store module)", () => {
  it("resolves to <Meetless home>/ce0/evidence.db", () => {
    expect(defaultCe0StorePath()).toBe(path.join(HOME, "ce0", "evidence.db"));
  });

  it("is re-exported from evidence.ts byte-identically (existing consumers stay valid)", () => {
    expect(evidenceReExport).toBe(defaultCe0StorePath);
    expect(evidenceReExport()).toBe(defaultCe0StorePath());
  });
});
