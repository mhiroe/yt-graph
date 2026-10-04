import type { CSSProperties } from "react";
import type { Inspection, RelatedEdge } from "../types";

const VERDICT_COLOR: Record<string, string> = {
  pass: "#44dd88",
  review: "#ccaa44",
  drop: "#885555",
};

const STATUS_COLOR: Record<string, string> = {
  seed: "#ffcc44",
  candidate: "#4488ff",
  accepted: "#44dd88",
  rejected: "#884444",
  later: "#888888",
};

const section: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #262626",
  fontSize: 12,
};

const sectionTitle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  opacity: 0.55,
  marginBottom: 6,
};

const kv: CSSProperties = { opacity: 0.8, lineHeight: 1.6 };

const pre: CSSProperties = {
  margin: "4px 0 0",
  padding: 6,
  background: "#141414",
  border: "1px solid #262626",
  borderRadius: 4,
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 160,
  overflowY: "auto",
};

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text === "{}") return null;
  return <pre style={pre}>{text}</pre>;
}

function EdgeLine({ edge, dir, onJump }: { edge: RelatedEdge; dir: "in" | "out"; onJump: (id: string) => void }) {
  return (
    <div style={kv}>
      <span style={{ opacity: 0.6 }}>{dir === "in" ? "←" : "→"}</span>{" "}
      <a
        style={{ color: "#77aaff", cursor: "pointer" }}
        onClick={() => onJump(edge.channel_id)}
      >
        {edge.title}
      </a>{" "}
      <span style={{ color: STATUS_COLOR[edge.status] ?? "#ccc" }}>({edge.status})</span>{" "}
      <span style={{ opacity: 0.6 }}>— {edge.kind} · {edge.created_at}</span>
    </div>
  );
}

/**
 * Inspection surface: drill-down drawer over the exploration graph. Holds the
 * full channel aggregate (detail / evidence / AI evaluations / related edges /
 * routing history) and the route actions — the place a human digs before
 * deciding. Later UX directions (swipe routing, search + preview, keyword
 * stock) mount alongside or inside this surface.
 */
export function InspectionDrawer({
  inspection,
  onClose,
  onJump,
  onDecide,
  onExpand,
  onEvaluate,
  busy,
}: {
  inspection: Inspection;
  onClose: () => void;
  onJump: (id: string) => void;
  onDecide: (id: string, decision: "accept" | "reject" | "later") => void;
  onExpand: (id: string) => void;
  onEvaluate: (id: string, force: boolean) => void;
  busy: boolean;
}) {
  const c = inspection.channel;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        bottom: 0,
        width: 430,
        background: "#151515",
        borderRight: "1px solid #333",
        overflowY: "auto",
        boxShadow: "4px 0 18px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ ...section, background: "#1a1a1a", position: "sticky", top: 0, zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div style={{ fontWeight: 600, fontSize: 14, paddingRight: 8 }}>{c.title}</div>
          <button onClick={onClose} style={{ flexShrink: 0 }}>
            close
          </button>
        </div>
        <div style={{ ...kv, fontSize: 11 }}>
          {c.id} {c.handle ?? ""} —{" "}
          <span style={{ color: STATUS_COLOR[c.status] ?? "#ccc" }}>{c.status}</span>
        </div>
        {c.url && (
          <a href={c.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#77aaff" }}>
            {c.url}
          </a>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {(c.status === "candidate" || c.status === "later") && (
            <>
              <button disabled={busy} onClick={() => onDecide(c.id, "accept")}>
                accept
              </button>
              <button disabled={busy} onClick={() => onDecide(c.id, "later")}>
                later
              </button>
              <button disabled={busy} onClick={() => onDecide(c.id, "reject")}>
                reject
              </button>
              {/* adhoc: one-shot human-initiated evaluation, separate from the batch judge */}
              <button
                disabled={busy}
                onClick={() => onEvaluate(c.id, inspection.judgments.length > 0)}
              >
                {inspection.judgments.length > 0 ? "re-evaluate" : "evaluate now"}
              </button>
            </>
          )}
          {(c.status === "accepted" || c.status === "seed") && (
            <button disabled={busy} onClick={() => onExpand(c.id)}>
              expand
            </button>
          )}
        </div>
      </div>

      <div style={section}>
        <div style={sectionTitle}>detail</div>
        {c.description && <div style={{ ...kv, marginBottom: 4 }}>{c.description}</div>}
        <div style={kv}>
          first seen {c.first_seen_at} · last seen {c.last_seen_at}
        </div>
        {inspection.snapshot && (
          <>
            <div style={{ ...kv, marginTop: 4 }}>snapshot @ {inspection.snapshot.fetched_at}</div>
            <JsonBlock value={inspection.snapshot.payload} />
          </>
        )}
      </div>

      <div style={section}>
        <div style={sectionTitle}>AI evaluations ({inspection.judgments.length})</div>
        {inspection.judgments.length === 0 && <div style={kv}>—</div>}
        {inspection.judgments.map((j) => (
          <div key={j.id} style={{ marginBottom: 8 }}>
            <div style={kv}>
              <span style={{ color: VERDICT_COLOR[j.verdict ?? ""] ?? "#ccc" }}>
                {j.verdict ?? "?"}
              </span>{" "}
              {j.score !== null ? j.score.toFixed(2) : "—"} by {j.judge} · {j.created_at}
            </div>
            <JsonBlock value={j.criteria} />
          </div>
        ))}
      </div>

      <div style={section}>
        <div style={sectionTitle}>evidence ({inspection.evidence.length})</div>
        {inspection.evidence.length === 0 && <div style={kv}>—</div>}
        {inspection.evidence.map((e) => (
          <div key={e.id} style={{ marginBottom: 8 }}>
            <div style={kv}>
              <span style={{ color: "#ccaa88" }}>{e.source}</span>
              {e.seed_channel_id && <span style={{ opacity: 0.6 }}> via {e.seed_channel_id}</span>}
              <span style={{ opacity: 0.6 }}> · {e.created_at}</span>
            </div>
            <JsonBlock value={e.detail} />
          </div>
        ))}
      </div>

      <div style={section}>
        <div style={sectionTitle}>
          related edges ({inspection.edges.incoming.length + inspection.edges.outgoing.length})
        </div>
        {inspection.edges.incoming.length + inspection.edges.outgoing.length === 0 && (
          <div style={kv}>—</div>
        )}
        {inspection.edges.incoming.map((e) => (
          <EdgeLine key={`i${e.id}`} edge={e} dir="in" onJump={onJump} />
        ))}
        {inspection.edges.outgoing.map((e) => (
          <EdgeLine key={`o${e.id}`} edge={e} dir="out" onJump={onJump} />
        ))}
      </div>

      <div style={section}>
        <div style={sectionTitle}>routing history ({inspection.decisions.length})</div>
        {inspection.decisions.length === 0 && <div style={kv}>—</div>}
        {inspection.decisions.map((d) => (
          <div key={d.id} style={kv}>
            {d.decision}
            {d.note ? ` — ${d.note}` : ""}
            <span style={{ opacity: 0.6 }}> · {d.created_at}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
