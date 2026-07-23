// src/lib/agent-decision/index.ts
//
// Barrel for the provider-neutral agent-human decision contract. The canonical
// types and validator (T1) are the contract; the Claude normalizer (T2+) is the
// first consumer of it. Spec: notes/20260608-agent-decision-capture-design.md.

export * from "./types";
export * from "./validate";
export * from "./keys";
export * from "./normalize-claude";
export * from "./normalize-codex";
