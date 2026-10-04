import type { Candidate } from "../types";

const VERDICT_COLOR: Record<string, string> = {
  pass: "#44dd88",
  review: "#ccaa44",
  drop: "#885555",
};

const STATUS_ORDER: Record<string, number> = {
  candidate: 0,
  later: 1,
  accepted: 2,
  seed: 3,
  rejected: 4,
};

function verdictRank(c: Candidate): number {
  return c.judgment?.verdict === "pass" ? 0 : c.judgment?.verdict === "review" ? 1 : 2;
}

/** Right-hand panel: candidate list. Drill-down lives in InspectionDrawer. */
export function CandidatePanel({
  candidates,
  selectedId,
  onSelect,
}: {
  candidates: Candidate[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const sorted = [...candidates].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      verdictRank(a) - verdictRank(b) ||
      a.id.localeCompare(b.id),
  );

  return (
    <div style={{ width: 340, borderLeft: "1px solid #333", overflowY: "auto", height: "calc(100vh - 44px)" }}>
      {sorted.map((c) => (
        <div
          key={c.id}
          onClick={() => onSelect(c.id)}
          style={{
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 13,
            background: c.id === selectedId ? "#222" : "transparent",
            borderBottom: "1px solid #1c1c1c",
          }}
        >
          <span style={{ opacity: c.status === "rejected" ? 0.4 : 1 }}>{c.title}</span>
          <span style={{ float: "right", fontSize: 11, opacity: 0.7 }}>
            {c.judgment && (
              <span style={{ color: VERDICT_COLOR[c.judgment.verdict] ?? "#ccc" }}>
                {c.judgment.verdict} {c.judgment.score.toFixed(2)}
              </span>
            )}
            {" "}{c.status !== "candidate" && c.status}
          </span>
        </div>
      ))}
    </div>
  );
}
