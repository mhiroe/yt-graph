import type { SourceAdapter, SourceChannel } from "../sources/index.js";
import type { RawHit } from "./cleanup.js";

/**
 * Subscription-gap collaborative filtering (feasibility spike,
 * spec_product.md "discovery strategy"): viewers whose subscriptions
 * partially overlap the account's own ("similar but with unknown
 * territory") contribute their non-overlapping subscriptions as
 * missing-edge candidates. A gap channel shared by several similar viewers
 * is the strongest signal — `via_viewers` carries the count.
 *
 * Adapter surfaces the chain depends on:
 *   mySubscriptions()         — the overlap baseline (session adapters only)
 *   commentAuthorChannels()   — the "find similar viewers" entry point
 *   channelSubscriptions()    — a viewer's public subscriptions
 * Each is optional/absent-by-design on some adapters — the pass is a pure
 * candidate source: no writes, fail-soft per surface, and `gaps` reports
 * exactly which surfaces were missing (that report IS the spike deliverable).
 */

/** Per-viewer evaluation row — kept for the spike's feasibility report. */
export type ViewerOverlap = {
  id: string;
  title: string;
  /** subscription ids shared with the account's own set. */
  shared: string[];
  /** shared / viewer-sub count — spec prefers ~0.5 ("unknown territory"). */
  overlap: number;
  /** their subs not in the account's set — the missing-edge candidates. */
  gap_ids: string[];
  skipped?: string; // why the viewer contributed nothing
};

export type SubscriptionGapResult = {
  hits: RawHit[];
  viewers: ViewerOverlap[];
  /** Adapter surfaces missing for the chain (empty = fully wired). */
  gaps: string[];
};

const MAX_VIEWERS = 4;
const MAX_GAP_PER_VIEWER = 8;
const MIN_SHARED = 1;
/** Full overlap means no unknown territory left — nothing to learn. */
const MAX_OVERLAP = 1.0;

export async function runSubscriptionGap(
  adapter: SourceAdapter,
  seed: SourceChannel,
): Promise<SubscriptionGapResult> {
  const gaps: string[] = [];
  const viewers: ViewerOverlap[] = [];
  const hits = new Map<string, RawHit>();

  if (adapter.mySubscriptions === undefined) {
    gaps.push("subscriptions.mine surface unavailable on this adapter");
    return { hits: [], viewers, gaps };
  }
  const mine = new Set((await adapter.mySubscriptions()).map((c) => c.id));

  if (adapter.commentAuthorChannels === undefined) {
    gaps.push("comment-author surface (yt.videos.comments -> author channel ids) unavailable");
    return { hits: [], viewers, gaps };
  }
  const authors = (await adapter.commentAuthorChannels(seed.id, 25)).filter(
    (c) => c.id !== seed.id && !mine.has(c.id),
  );

  for (const viewer of authors.slice(0, MAX_VIEWERS)) {
    const subs = await adapter.channelSubscriptions(viewer.id);
    if (subs.length === 0) {
      viewers.push({ id: viewer.id, title: viewer.title, shared: [], overlap: 0, gap_ids: [], skipped: "subscriptions_not_public" });
      continue;
    }
    const shared = subs.map((s) => s.id).filter((id) => mine.has(id));
    const overlap = shared.length / subs.length;
    if (shared.length < MIN_SHARED || overlap >= MAX_OVERLAP) {
      viewers.push({ id: viewer.id, title: viewer.title, shared, overlap, gap_ids: [], skipped: "insufficient_overlap" });
      continue;
    }
    const gapChannels = subs.filter((s) => !mine.has(s.id)).slice(0, MAX_GAP_PER_VIEWER);
    viewers.push({
      id: viewer.id,
      title: viewer.title,
      shared,
      overlap,
      gap_ids: gapChannels.map((c) => c.id),
    });
    for (const ch of gapChannels) {
      const hit = hits.get(ch.id) ?? { channel: ch, evidence: [] };
      // One evidence entry per contributing viewer — the entry count on a
      // channel is the "shared by N similar viewers" signal strength.
      hit.evidence.push({
        source: "subscription_gap",
        detail: { via_viewer: viewer.id, shared, overlap },
      });
      hits.set(ch.id, hit);
    }
  }

  if (viewers.length === 0 && authors.length > 0) {
    gaps.push("no comment authors survived to evaluation");
  }
  return { hits: [...hits.values()], viewers, gaps };
}
