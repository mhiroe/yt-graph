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

/** Right-hand panel: candidate list + selected channel preview with route buttons. */
export function CandidatePanel({
  candidates,
  selectedId,
  onSelect,
  onDecide,
  onExpand,
  busy,
}: {
  candidates: Candidate[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDecide: (id: string, decision: "accept" | "reject" | "later") => void;
  onExpand: (id: string) => void;
  busy: boolean;
}) {
  const sorted = [...candidates].sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      verdictRank(a) - verdictRank(b) ||
      a.id.localeCompare(b.id),
  );
  const selected = candidates.find((c) => c.id === selectedId);

  return (
    <div style={{ width: 340, borderLeft: "1px solid #333", overflowY: "auto", height: "calc(100vh - 44px)" }}>
      {selected && (
        <div style={{ padding: 12, borderBottom: "1px solid #333", background: "#181818" }}>
          <div style={{ fontWeight: 600 }}>{selected.title}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {selected.id} {selected.handle ?? ""} — {selected.status}
          </div>
          {selected.description && (
            <div style={{ fontSize: 12, margin: "6px 0", opacity: 0.85 }}>{selected.description}</div>
          )}
          {selected.url && (
            <a href={selected.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#77aaff" }}>
              {selected.url}
            </a>
          )}
          <div style={{ fontSize: 12, margin: "6px 0" }}>
            sources: {selected.sources.join(", ") || "—"} ({selected.evidence_count})
            {selected.judgment && (
              <>
                {" — "}
                <span style={{ color: VERDICT_COLOR[selected.judgment.verdict] ?? "#ccc" }}>
                  {selected.judgment.verdict} {selected.judgment.score.toFixed(2)}
                </span>
                {" by "}{selected.judgment.judge}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {(selected.status === "candidate" || selected.status === "later") && (
              <>
                <button disabled={busy} onClick={() => onDecide(selected.id, "accept")}>accept</button>
                <button disabled={busy} onClick={() => onDecide(selected.id, "later")}>later</button>
                <button disabled={busy} onClick={() => onDecide(selected.id, "reject")}>reject</button>
              </>
            )}
            {(selected.status === "accepted" || selected.status === "seed") && (
              <button disabled={busy} onClick={() => onExpand(selected.id)}>expand</button>
            )}
          </div>
        </div>
      )}
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
