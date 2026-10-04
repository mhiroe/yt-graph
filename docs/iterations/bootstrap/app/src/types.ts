/** API shapes mirrored client-side (server files import node:sqlite — no sharing). */
export type Candidate = {
  id: string;
  title: string;
  status: string;
  handle: string | null;
  description: string | null;
  url: string | null;
  sources: string[];
  evidence_count: number;
  judgment?: { judge: string; score: number; verdict: string };
};

/** `/api/inspect` aggregate — one channel fully opened for human digging. */
export type Inspection = {
  channel: {
    id: string;
    title: string;
    handle: string | null;
    description: string | null;
    url: string | null;
    status: string;
    first_seen_at: string;
    last_seen_at: string;
  };
  evidence: {
    id: number;
    seed_channel_id: string | null;
    source: string;
    detail: unknown;
    created_at: string;
  }[];
  judgments: {
    id: number;
    judge: string;
    criteria: unknown;
    score: number | null;
    verdict: string | null;
    created_at: string;
  }[];
  decisions: { id: number; decision: string; note: string | null; created_at: string }[];
  edges: {
    incoming: RelatedEdge[];
    outgoing: RelatedEdge[];
  };
  snapshot: { fetched_at: string; payload: unknown } | null;
};

export type RelatedEdge = {
  id: number;
  kind: string;
  created_at: string;
  channel_id: string;
  title: string;
  status: string;
};
