import { extractNeedles } from "../../src/lib/evidence-pointer";

// M8: a needle must come from the INSPECTION's own arguments, not from anywhere in a
// compound shell line.
//
// THE MEASURED FALSE POSITIVE (session 0b2d408c turn 2, 2026-08-09T12:08:57Z). The agent
// ran, verbatim:
//
//   PW=$(grep -E "^DATABASE_URL" .env | sed -E 's|...|\1|'); echo "=== backlog ==="; \
//   docker exec -e PGPASSWORD="$PW" meetless_db_postgres psql -U meetless -d intel-dev \
//     -t -A -c "select ... from \"IntelJob\" ..."
//
// and the hook answered with `NT:notes/20260721-correction-band-lineage-writer-trace.md
// [pending] was already delivered to you THIS TURN and it contains the literal
// "intel-dev" you are searching for`. The note is about predecessor-lineage occupancy;
// it merely happens to say "Measured against `intel-dev` (local dev substrate)".
//
// TWO SEPARATE ADMISSIONS PRODUCED IT, and only the second is fixable without cost:
//
//   1. The verb gate is a whole-command regex, so the `grep` inside a command
//      substitution that reads a PASSWORD out of `.env` made a `docker exec ... psql`
//      line look like a lookup. Nearly every shell one-liner in this repo contains a
//      grep somewhere.
//   2. Tokenization then swept the WHOLE line, so `intel-dev` -- the `-d` argument of
//      psql, a connection target and not a topic -- became a needle. It is a perfectly
//      good identifier shape and passes every distinctiveness rule there is, which is
//      why no needle-shape rule could ever have caught this.
//
// The fix is to segment the command on shell separators and keep only the segments an
// inspection verb HEADS. That is what "the arguments off an inspecting Bash command"
// already claims to mean; it was simply implemented over the whole string. Precision
// over recall, as the module states: a `docker exec ... grep` is now silent, and
// silence costs nothing while a pointer on plumbing costs credibility.
describe("M8: needles come from the inspection's own segment", () => {
  const PSQL_BACKLOG =
    'PW=$(grep -E "^DATABASE_URL" .env | sed -E \'s|.*://meetless:([^@]*)@.*|\\1|\'); ' +
    'echo "=== total ONTOLOGY_EXTRACT backlog ==="; ' +
    'docker exec -e PGPASSWORD="$PW" meetless_db_postgres psql -U meetless -d intel-dev -t -A -F\'|\' ' +
    '-c "select \\"statusName\\", count(*) from \\"IntelJob\\" group by 1;"';

  it("does not take a psql connection target as a needle", () => {
    expect(extractNeedles("Bash", { command: PSQL_BACKLOG })).not.toContain("intel-dev");
  });

  it("does not take anything else off the docker/psql segment either", () => {
    const needles = extractNeedles("Bash", { command: PSQL_BACKLOG });
    for (const plumbing of ["meetless_db_postgres", "PGPASSWORD=", "meetless"]) {
      expect(needles).not.toContain(plumbing);
    }
  });

  it("a grep that only reads a credential out of .env contributes no usable needle", () => {
    // The one segment an inspection verb DOES head here is
    // `grep -E "^DATABASE_URL" .env`, whose tokens are a regex (rejected: `^`) and a
    // bare dotfile (rejected: one generic word plus an extension). So the whole line
    // is correctly silent rather than correctly-scoped-but-still-firing.
    const needles = extractNeedles("Bash", { command: PSQL_BACKLOG }).filter((n) => n !== ".env");
    expect(needles.filter((n) => !n.startsWith("^") && !n.startsWith("$"))).toEqual([]);
  });

  it("a real inspection still yields its argument, in every separator shape", () => {
    expect(extractNeedles("Bash", { command: "grep -rn current_revision_id intel/app" })).toContain(
      "current_revision_id",
    );
    // Piped read-into-read: BOTH segments are inspections and both contribute.
    const piped = extractNeedles("Bash", { command: "git show HEAD:profiles.py | grep MARKDOWN_ATOMIC_V1" });
    expect(piped).toContain("MARKDOWN_ATOMIC_V1");
    expect(piped).toContain("HEAD:profiles.py");
    // A `;`-joined pair where only the second is an inspection.
    expect(
      extractNeedles("Bash", { command: 'echo "checking"; git log --oneline -- notes/20260806-mla-plan.md' }),
    ).toContain("notes/20260806-mla-plan.md");
    // A `&&`-joined pair where only the first is.
    expect(
      extractNeedles("Bash", { command: "grep -rn PROFILES_BY_NAME intel/app && pnpm run build" }),
    ).toContain("PROFILES_BY_NAME");
    expect(extractNeedles("Bash", { command: "grep -rn PROFILES_BY_NAME intel/app && pnpm run build" })).not.toContain(
      "build",
    );
  });

  it("a command with no inspection segment at all is still silent", () => {
    expect(extractNeedles("Bash", { command: "pnpm run build && pnpm test" })).toEqual([]);
    expect(extractNeedles("Bash", { command: "docker exec db psql -d intel-dev -c 'select 1'" })).toEqual([]);
  });

  it("the redirect and heredoc guard is unchanged", () => {
    expect(extractNeedles("Bash", { command: "grep -rn PROFILES_BY_NAME src/ > /tmp/out.txt" })).toEqual([]);
    expect(extractNeedles("Bash", { command: "cat >> notes/x.md <<'EOF'\nbody\nEOF" })).toEqual([]);
  });
});
