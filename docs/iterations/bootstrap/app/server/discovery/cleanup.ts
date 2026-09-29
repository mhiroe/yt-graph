import type { SourceChannel } from "../sources/index.js";

export type RawHit = {
  channel: SourceChannel;
  /** one entry per surface the channel arrived through */
  evidence: { source: string; detail: unknown }[];
};

export type CleanupResult = {
  kept: RawHit[];
  dropped: { id: string; reason: string }[];
};

/**
 * Deterministic cleanup — the funnel stage before any judgment. Pure rules,
 * no model: dedupe by id, drop the seed itself, drop already-rejected
 * channels, drop hits with no provenance (must not happen — flagged loudly).
 */
export function cleanup(hits: RawHit[], seedId: string, rejected: Set<string>): CleanupResult {
  const kept: RawHit[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = hit.channel.id;
    if (seen.has(id)) {
      dropped.push({ id, reason: "duplicate" });
      continue;
    }
    seen.add(id);
    if (id === seedId) dropped.push({ id, reason: "is_seed" });
    else if (rejected.has(id)) dropped.push({ id, reason: "already_rejected" });
    else if (hit.evidence.length === 0) dropped.push({ id, reason: "no_provenance" });
    else kept.push(hit);
  }
  return { kept, dropped };
}
