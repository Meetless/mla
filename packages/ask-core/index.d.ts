/**
 * Hand-written type surface for @meetless/ask-core (plain-ESM package).
 *
 * The runtime is authored in plain ESM JavaScript (matching ask_modes.js's
 * original form in meetless-mcp). This declaration file lets TypeScript
 * front-ends (the `mla` CLI) consume the package with full types without
 * forking the JS into a TS build. The MCP front-end is plain JS and needs no
 * type layer.
 */

declare module "@meetless/ask-core/ask_modes.js" {
  export interface IntelAskArgs {
    question: string;
    workspaceId: string;
    mode?: string;
    filters?: Record<string, unknown>;
    maxResults?: number;
    minResults?: number;
    /** B9: VALID-time point-in-time cutoff (UTC ISO-8601), forwarded as the
     * intel ask body's `as_of`. Absent on the MCP path (byte-identical). */
    asOf?: string;
  }
  export type IntelAsk = (args: IntelAskArgs) => Promise<Record<string, unknown>>;

  export function makeIntelAsk(deps: {
    intelBaseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
  }): IntelAsk;

  export function normalizeIntelResponse(
    raw: Record<string, unknown>,
    mode: string,
  ): Record<string, unknown>;

  export interface AskModeArgs {
    query: string;
    workspace_id?: string;
    filters?: Record<string, unknown>;
    maxResults?: number;
    minResults?: number;
    /** B9: VALID-time point-in-time cutoff (UTC ISO-8601). Threaded into the
     * intel ask body's `as_of` by the mode handlers. */
    as_of?: string;
  }
  export type AskModeHandler = (args: AskModeArgs) => Promise<Record<string, unknown>>;

  export function makeAskModes(deps: {
    intelAsk: IntelAsk;
    defaultWorkspaceId: string;
    matchCanonical: (query: string) => { matches: unknown[]; reason: string };
    statusFallback: (
      results: unknown[],
      filters: Record<string, unknown> | null | undefined,
      minResults: number | undefined,
    ) => { results: unknown[]; warnings: string[] };
  }): {
    runAnswer: AskModeHandler;
    runSearch: AskModeHandler;
    runCanonical: AskModeHandler;
    runCompare: AskModeHandler;
  };
}

declare module "@meetless/ask-core/status_fallback.js" {
  export function statusFallback(
    results: unknown[],
    filters: { statuses?: string[] } | null | undefined,
    minResults: number | undefined,
  ): { results: unknown[]; warnings: string[] };
}

declare module "@meetless/ask-core/match_canonical.js" {
  export function normalizeTopic(s: string): string;
  export function makeMatchCanonical(deps: {
    notesRoot: string;
  }): (query: string) => { matches: unknown[]; reason: string };
}
