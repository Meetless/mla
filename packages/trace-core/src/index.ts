// mla observability spine, Plane 2 (tracing).
//
// In-memory tracer + bounded flush to control. See notes/20260530-mla-
// observability-diagnostic-spine.md §6 for the full contract.
//
// Invariants we enforce here so call sites cannot drift:
//   - root span ends with the correct status BEFORE flush (§6.1)
//   - endRoot is idempotent (§6.2)
//   - incomplete child spans serialize as status: "aborted" at flush time (§6.2)
//   - in-memory only; no JSONL, no cursor, no retry (§6.2)
//   - flush() POSTs once to control's POST /internal/v1/agent-traces/ingest;
//     the caller wraps it in boundedTraceFlush (§6.1) for the 500 ms ceiling.

import * as crypto from "crypto";

export type SpanStatus = "ok" | "error" | "aborted";

export interface Span {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: string;
  endTime: string | null;
  status: SpanStatus;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; time: string; attributes?: Record<string, unknown> }>;
}

export interface SpanHandle {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  end(opts: { status: SpanStatus; output?: unknown; error?: unknown }): void;
  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  isEnded(): boolean;
}

export interface ClientInfo {
  mlaVersion: string;
  platform: string;
}

export interface TracerOptions {
  traceId: string;
  rootName: string;
  client: ClientInfo;
  flushFn?: FlushFn;
}

export interface FlushPayload {
  traceId: string;
  rootSpan: Span;
  spans: Span[];
  client: ClientInfo;
}

export type FlushFn = (payload: FlushPayload) => Promise<void>;

export interface Tracer {
  readonly traceId: string;
  readonly root: SpanHandle;
  startSpan(opts: {
    name: string;
    parent?: SpanHandle | null;
    input?: unknown;
  }): SpanHandle;
  endRoot(opts: { status: "ok" | "error"; output?: unknown; error?: unknown }): void;
  flush(): Promise<void>;
  snapshot(): { rootSpan: Span; spans: Span[] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

class SpanImpl implements SpanHandle {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTime: string;
  private input?: unknown;
  private output?: unknown;
  private status: SpanStatus | null;
  private endTime: string | null;
  private error?: unknown;
  private readonly attributes: Record<string, unknown>;
  private readonly events: Array<{
    name: string;
    time: string;
    attributes?: Record<string, unknown>;
  }>;

  constructor(opts: { name: string; parent: SpanHandle | null; input?: unknown }) {
    this.spanId = newSpanId();
    this.parentSpanId = opts.parent?.spanId ?? null;
    this.name = opts.name;
    this.startTime = nowIso();
    this.endTime = null;
    this.status = null;
    this.input = opts.input;
    this.attributes = {};
    this.events = [];
  }

  end(opts: { status: SpanStatus; output?: unknown; error?: unknown }): void {
    if (this.status !== null) return;
    this.status = opts.status;
    this.endTime = nowIso();
    if (opts.output !== undefined) this.output = opts.output;
    if (opts.error !== undefined) this.error = opts.error;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.events.push({ name, time: nowIso(), attributes });
  }

  isEnded(): boolean {
    return this.status !== null;
  }

  // Snapshot for flush. Aborted-at-flush logic: if the span never ended (CLI
  // killed mid-call), serialize as status: "aborted" + endTime = flush time,
  // so Langfuse shows exactly the place we lost the run.
  toJSON(flushTime: string): Span {
    const status: SpanStatus = this.status ?? "aborted";
    const endTime = this.endTime ?? flushTime;
    const span: Span = {
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime,
      status,
    };
    if (this.input !== undefined) span.input = this.input;
    if (this.output !== undefined) span.output = this.output;
    if (this.error !== undefined) {
      span.attributes = { ...this.attributes, error: serializeError(this.error) };
    } else if (Object.keys(this.attributes).length > 0) {
      span.attributes = { ...this.attributes };
    }
    if (this.events.length > 0) span.events = [...this.events];
    return span;
  }
}

class TracerImpl implements Tracer {
  readonly traceId: string;
  readonly root: SpanHandle;
  private readonly children: SpanImpl[];
  private readonly rootImpl: SpanImpl;
  private readonly client: ClientInfo;
  private readonly flushFn: FlushFn;
  private rootEnded: boolean;
  private flushed: boolean;

  constructor(opts: TracerOptions) {
    this.traceId = opts.traceId;
    this.client = opts.client;
    this.flushFn = opts.flushFn ?? defaultNoFlush;
    this.children = [];
    this.rootImpl = new SpanImpl({ name: opts.rootName, parent: null });
    this.root = this.rootImpl;
    this.rootEnded = false;
    this.flushed = false;
  }

  startSpan(opts: {
    name: string;
    parent?: SpanHandle | null;
    input?: unknown;
  }): SpanHandle {
    const parent = opts.parent ?? this.root;
    const child = new SpanImpl({ name: opts.name, parent, input: opts.input });
    this.children.push(child);
    return child;
  }

  endRoot(opts: { status: "ok" | "error"; output?: unknown; error?: unknown }): void {
    if (this.rootEnded) return;
    this.rootEnded = true;
    this.rootImpl.end(opts);
  }

  snapshot(): { rootSpan: Span; spans: Span[] } {
    const flushTime = nowIso();
    return {
      rootSpan: this.rootImpl.toJSON(flushTime),
      spans: this.children.map((c) => c.toJSON(flushTime)),
    };
  }

  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    const { rootSpan, spans } = this.snapshot();
    const payload: FlushPayload = {
      traceId: this.traceId,
      rootSpan,
      spans,
      client: this.client,
    };
    await this.flushFn(payload);
  }
}

async function defaultNoFlush(_payload: FlushPayload): Promise<void> {
  // No-op default. Real tracers pass an HTTP-backed flushFn that POSTs to
  // control's /internal/v1/agent-traces/ingest. Default is a no-op so the
  // tracer is usable in unit tests without an HTTP fixture.
}

export function makeTracer(opts: TracerOptions): Tracer {
  return new TracerImpl(opts);
}

// Make-no-op tracer for runs where tracing is disabled on the workspace. Same
// shape as a real tracer so call sites can be unconditional, but everything is
// a no-op and flush() resolves immediately.
export function makeNoopTracer(opts: { traceId: string }): Tracer {
  const noopHandle: SpanHandle = {
    spanId: "noop",
    parentSpanId: null,
    end() {
      /* noop */
    },
    setAttribute() {
      /* noop */
    },
    addEvent() {
      /* noop */
    },
    isEnded() {
      return true;
    },
  };
  const emptyRoot: Span = {
    spanId: "noop",
    parentSpanId: null,
    name: "noop",
    startTime: nowIso(),
    endTime: nowIso(),
    status: "ok",
  };
  return {
    traceId: opts.traceId,
    root: noopHandle,
    startSpan: () => noopHandle,
    endRoot: () => undefined,
    snapshot: () => ({ rootSpan: emptyRoot, spans: [] }),
    flush: async () => undefined,
  };
}

export { serializeError };
