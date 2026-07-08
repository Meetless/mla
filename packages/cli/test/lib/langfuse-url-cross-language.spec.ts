// P2-T5 (TS half): langfuseTraceUrl must match the shared cross-language fixture
// byte-for-byte. The same fixture (test/fixtures/langfuse-url-fixtures.json,
// duplicated into intel/tests/fixtures) drives the Python twin's test. If either
// builder drifts from this format, the Sentry deep-link it produces would 404 in
// the other plane; this test catches the TS side of that drift.

import * as fs from "fs";
import * as path from "path";

import { langfuseTraceUrl } from "../../src/lib/observability";

interface UrlCase {
  projectId: string;
  traceId: string;
  url: string;
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "langfuse-url-fixtures.json"),
    "utf8",
  ),
) as { host: string; cases: UrlCase[] };

describe("langfuseTraceUrl cross-language fixture (P2-T5)", () => {
  it("has fixture rows to assert against", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it("matches the shared fixture byte-for-byte (must equal intel's langfuse_trace_url)", () => {
    for (const c of fixture.cases) {
      expect(langfuseTraceUrl(c.projectId, c.traceId)).toBe(c.url);
    }
  });

  it("always uses the Langfuse Cloud host declared in the fixture", () => {
    for (const c of fixture.cases) {
      expect(langfuseTraceUrl(c.projectId, c.traceId).startsWith(fixture.host)).toBe(
        true,
      );
    }
  });
});
