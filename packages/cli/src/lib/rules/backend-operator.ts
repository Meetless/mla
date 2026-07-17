// src/lib/rules/backend-operator.ts
//
// Who is minting? A binding rule REQUIRES an authenticated human (rules-store-unification
// acceptance 8): only a `user-token` session carries a real Console identity the backend can
// audit as the attestor. A shared-key (CI / headless) session and a logged-out one are NOT
// humans and are refused locally with a clear pointer, rather than as a bare server 403.
//
// This lives in lib (not in a command) because two commands now mint: `mla rules add` and
// `mla enrich accept` (acceptance IS the mint). One resolver, one refusal message.
import { readConfig } from "../config";

export interface BackendOperator {
  /** The audited human; only a user-token session is a human attestor (acceptance 8). */
  userId: string;
  displayName?: string;
}

/** Read the audited operator from the session; only a user-token is a human author/attestor. */
export function resolveBackendOperator(): BackendOperator | null {
  const cfg = readConfig();
  if (cfg.auth.mode !== "user-token") return null;
  return { userId: cfg.auth.user.id, displayName: cfg.auth.user.displayName || cfg.auth.user.id };
}
