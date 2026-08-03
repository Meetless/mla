// INV-ARGV-1 on the SENTRY plane. Same defect as the trace plane, three seams.
//
// trace-error-reduction.spec.ts closed the error on the run-trace plane. Sentry
// is a second wire out of the same process and it was never audited the same
// way: `20260726-mla-redaction-egress-boundary.md` recorded Sentry as "clean"
// because every event goes through `redactSentryEvent`. That redactor is the
// key-aware structural walker. It strips token shapes, paths and values under
// telling keys. It does nothing to English, which is the entire lesson of the
// argv fix, and Sentry's default posture is to collect English:
//
//   1. `exception.values[].value` is the throw site's message, and this CLI
//      interpolates raw argv into 133 of them.
//   2. the `Console` integration turns EVERY line the CLI prints into a
//      breadcrumb. `mla ask` prints the answer. `mla kb show` prints the doc.
//   3. the `Http`/`NodeFetch` integrations turn every outbound call into a
//      breadcrumb carrying the raw path and query string. The trace plane rolls
//      those up to `coordination-cases.:id` precisely because the raw one is
//      user data; Sentry shipped `?q=<the user's whole question>`.
//
// So the assertions here are on THE BYTES THE TRANSPORT WAS ASKED TO SEND, not
// on a hand-built event shape. A hand-built shape can only confirm its author's
// assumption about what the SDK collects, and what the SDK collects by default
// is most of the problem.

import * as Sentry from "@sentry/node";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  initSentry,
  sentryCliIntegrationNames,
  SENTRY_MESSAGE_WITHHELD,
} from "../../src/lib/observability";

const FLAG = "--acme-sso-q3-pilot-secret";
const USAGE_MESSAGE = `Unknown flag: ${FLAG}. Supported flags: --plain, --no-flush`;
const USER_QUESTION = "why did we defer SSO for the Q3 Acme pilot";

// A syntactically valid DSN pointing nowhere. The transport is replaced before
// anything is captured, so no packet is ever built for it.
const FAKE_DSN = "https://abc0123456789abcdef0123456789abc@o1.ingest.sentry.io/1";

const DEV_BUILD = {
  version: "0.0.0-test",
  sha: "deadbeef",
  dirty: true,
  sentryDsn: null,
} as unknown as Parameters<typeof initSentry>[0];

let sent: string[] = [];

function startCli(): Sentry.NodeClient {
  process.env.MEETLESS_SENTRY_DSN = FAKE_DSN;
  delete process.env.MEETLESS_TELEMETRY;
  delete process.env.MEETLESS_NO_TELEMETRY;
  expect(initSentry(DEV_BUILD)).toBe(true);
  const client = Sentry.getClient<Sentry.NodeClient>()!;
  sent = [];
  const transport = client.getTransport()!;
  // The narrowest real boundary: whatever reaches here is on the wire.
  transport.send = async (envelope) => {
    sent.push(JSON.stringify(envelope));
    return { statusCode: 200 };
  };
  return client;
}

function wire(): string {
  return sent.join("\n");
}

function occurrences(needle: string): number {
  return wire().split(needle).length - 1;
}

describe("the Sentry plane carries no free text", () => {
  afterEach(async () => {
    const client = Sentry.getClient();
    if (client) await client.close(0);
    Sentry.getGlobalScope().clear();
    delete process.env.MEETLESS_SENTRY_DSN;
    sent = [];
  });

  it("drops the exception message that carried the user's own flag", async () => {
    startCli();
    function parseArgs(argv: string[]): never {
      throw new Error(`Unknown flag: ${argv[0]}. Supported flags: --plain, --no-flush`);
    }
    try {
      parseArgs([FLAG, USER_QUESTION]);
    } catch (err) {
      Sentry.captureException(err);
    }
    await Sentry.flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    expect(occurrences(FLAG)).toBe(0);
    expect(occurrences("Unknown flag")).toBe(0);
    expect(occurrences("acme")).toBe(0);
    // What survives is what is OURS to say: the type, our frames, and a
    // placeholder that tells whoever opens the issue where the text went.
    expect(wire()).toContain(SENTRY_MESSAGE_WITHHELD);
    expect(wire()).toContain('"type":"Error"');
    expect(wire()).toContain("parseArgs");
  });

  it("reduces EVERY value in a linked cause chain, not just the outermost", async () => {
    startCli();
    const cause = new Error(`spawn failed for ${USER_QUESTION}`);
    Sentry.captureException(new Error(USAGE_MESSAGE, { cause }));
    await Sentry.flush(2000);

    expect(occurrences(FLAG)).toBe(0);
    expect(occurrences("defer SSO")).toBe(0);
    expect(occurrences("spawn failed")).toBe(0);
    // LinkedErrors expands the chain into two exception values; both reduced.
    expect(occurrences(SENTRY_MESSAGE_WITHHELD)).toBeGreaterThanOrEqual(2);
  });

  it("does not turn what the CLI PRINTS into a breadcrumb", async () => {
    startCli();
    // This is `mla ask` doing its job: the answer goes to the user's terminal.
    console.log(`Answer: we deferred SSO for the Q3 Acme pilot to unblock billing`);
    console.error(`Error: ${USAGE_MESSAGE}`);
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    expect(occurrences("category\":\"console")).toBe(0);
    expect(occurrences("Acme")).toBe(0);
    expect(occurrences(FLAG)).toBe(0);
  });

  it("does not turn an outbound request's path or query into a breadcrumb", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      startCli();
      const path = `/internal/v1/coordination-cases/cc_acme_sso_q3?q=${encodeURIComponent(
        USER_QUESTION,
      )}`;
      await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
      Sentry.captureException(new Error("boom"));
      await Sentry.flush(2000);

      expect(occurrences("cc_acme_sso_q3")).toBe(0);
      expect(occurrences("coordination-cases")).toBe(0);
      expect(occurrences("defer")).toBe(0);
      expect(occurrences("http.query")).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps captureMessage intact, because that string is ours by construction", async () => {
    startCli();
    // captureCliNonZeroExit's text: the command is already the reduced keyword.
    Sentry.captureMessage("mla review exited 1");
    await Sentry.flush(2000);
    expect(wire()).toContain("mla review exited 1");
    expect(occurrences(SENTRY_MESSAGE_WITHHELD)).toBe(0);
  });

  it("runs only the CLI integration allowlist, so a new SDK default cannot add a capture source", () => {
    const client = startCli();
    // Reaching into `_integrations` is deliberate: it is the only view of what
    // is ACTUALLY active, and a behavioral test can only cover the collectors we
    // already thought of. This one fails when the SDK adds a new default.
    const active = Object.keys(
      (client as unknown as { _integrations: Record<string, unknown> })._integrations,
    ).sort();
    expect(active).toEqual(sentryCliIntegrationNames().sort());
  });

  it("never opts into local variable capture, which would ship every local by name", () => {
    // `includeLocalVariables` attaches the VALUES of locals on the crashing
    // frame. A local named `question`, `argv` or `prompt` clears the key-aware
    // redactor untouched, so this option is a leak switch, not a debug switch.
    const client = startCli();
    expect(client.getOptions().includeLocalVariables).toBeFalsy();
  });
});
