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
