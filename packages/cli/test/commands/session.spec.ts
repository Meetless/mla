// `mla session reconcile [--dry-run] [--json]` argument parsing.
//
// reconcile takes NO positional sid (it sweeps the whole workspace), so the only
// surface to pin here is the two boolean flags and rejection of anything else.
// The reconcile DECISION + archive logic is covered end-to-end in
// test/lib/reconcile-sessions.spec.ts (executeSessionReconcile); this file guards
// only the thin command-arg contract so a typo'd flag fails loud instead of being
// silently ignored (which, for a destructive-looking verb, would be a trap).

import { parseReconcileArgs } from "../../src/commands/session";

describe("parseReconcileArgs", () => {
  it("defaults to a real run rendered for humans (no flags)", () => {
    expect(parseReconcileArgs([])).toEqual({ dryRun: false, json: false });
  });

  it("parses --dry-run", () => {
    expect(parseReconcileArgs(["--dry-run"])).toEqual({ dryRun: true, json: false });
  });

  it("parses --json", () => {
    expect(parseReconcileArgs(["--json"])).toEqual({ dryRun: false, json: true });
  });

  it("parses both flags in either order", () => {
    expect(parseReconcileArgs(["--json", "--dry-run"])).toEqual({ dryRun: true, json: true });
    expect(parseReconcileArgs(["--dry-run", "--json"])).toEqual({ dryRun: true, json: true });
  });

  it("rejects an unknown flag (fails loud, never silently ignored)", () => {
    expect(() => parseReconcileArgs(["--force"])).toThrow(/Unknown flag/);
  });

  it("rejects a positional argument (reconcile sweeps the workspace, takes no sid)", () => {
    expect(() => parseReconcileArgs(["some-sid"])).toThrow(/no positional|takes no/i);
  });
});
