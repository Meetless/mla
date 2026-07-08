// A3: deterministic supersession/contradiction warning for docs the user names in
// a prompt. No LLM: a pure join over LIVE/ACCEPTED KB relation facts. Only approved
// facts may surface (never unapproved state). See spec test 12.
export interface KbRelationFact {
  fromPath: string;
  relationType: string; // SUPERSEDED_BY, CONTRADICTS
  toPath: string;
  toKbId: string;
  posture: "LIVE" | "SHADOW";
  status: "ACCEPTED" | "PENDING_REVIEW" | "REJECTED";
}
export interface TaggedAdvisory {
  citedKbId: string;
  message: string;
}
export function supersessionAdvisory(referencedPaths: string[], facts: KbRelationFact[]): TaggedAdvisory[] {
  const refs = new Set(referencedPaths);
  const out: TaggedAdvisory[] = [];
  for (const f of facts) {
    if (!refs.has(f.fromPath)) continue;
    if (f.posture !== "LIVE" || f.status !== "ACCEPTED") continue; // approved facts only
    if (f.relationType === "SUPERSEDED_BY") {
      out.push({ citedKbId: f.toKbId, message: `${f.fromPath} is superseded by ${f.toPath} (${f.toKbId}); prefer the newer doc.` });
    } else if (f.relationType === "CONTRADICTS") {
      out.push({ citedKbId: f.toKbId, message: `${f.fromPath} contradicts ${f.toPath} (${f.toKbId}).` });
    }
  }
  return out;
}
