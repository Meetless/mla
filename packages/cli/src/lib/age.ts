// src/lib/age.ts
//
// One human-readable "how old is this artifact" formatter, shared by every surface that
// reports on a cached file (`mla doctor`'s rule-delivery checks, `mla status`'s foreign-root
// message). It lived privately inside doctor.ts; status needs the identical phrasing, and two
// copies of a time formatter drift into two different vocabularies for the same fact.
//
// Pure and `now`-injected so callers stay deterministic under test.
export function ageLabel(from: string | undefined, now: Date): string {
  if (!from) return "unknown age";
  const ms = now.getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
