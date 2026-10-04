import { useCallback, useEffect, useRef, useState } from "react";
import { GraphView, type GraphData } from "./graph/GraphView";
import { CandidatePanel } from "./ui/CandidatePanel";
import { InspectionDrawer } from "./ui/InspectionDrawer";
import type { Candidate, Inspection } from "./types";

async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `http ${r.status}`);
  return b;
}

export function App() {
  const [health, setHealth] = useState<string>("checking…");
  const [graph, setGraph] = useState<GraphData>({ channels: [], edges: [] });
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [seedRef, setSeedRef] = useState("FIXSEED001");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadInspection = useCallback((id: string | null) => {
    if (!id) {
      setInspection(null);
      return;
    }
    fetch(`/api/inspect?channel_id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`))))
      .then((b) => setInspection(b as Inspection))
      .catch(() => setInspection(null));
  }, []);

  const refresh = useCallback(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((b) => setGraph({ channels: b.channels ?? [], edges: b.edges ?? [] }))
      .catch(() => setGraph({ channels: [], edges: [] }));
    fetch("/api/candidates")
      .then((r) => r.json())
      .then((b) => setCandidates(b.candidates ?? []))
      .catch(() => setCandidates([]));
    loadInspection(selectedRef.current);
  }, [loadInspection]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((b) => setHealth(b.ok ? `api ok (${b.service})` : "api error"))
      .catch(() => setHealth("api unreachable"));
    refresh();
  }, [refresh]);

  useEffect(() => {
    loadInspection(selectedId);
  }, [selectedId, loadInspection]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div style={{ fontFamily: "system-ui", color: "#eee", background: "#111", height: "100vh" }}>
      <header style={{ padding: "8px 16px", display: "flex", gap: 12, alignItems: "center" }}>
        <strong>yt-graph</strong>
        <span>{health}</span>
        <span>
          {graph.channels.length} channels / {graph.edges.length} edges
        </span>
        <input
          value={seedRef}
          onChange={(e) => setSeedRef(e.target.value)}
          style={{ width: 110, background: "#1c1c1c", color: "#eee", border: "1px solid #333" }}
        />
        <button disabled={busy} onClick={() => run(() => post("/api/discover", { seed: seedRef }))}>
          discover
        </button>
        <button disabled={busy} onClick={() => run(() => post("/api/judge", {}))}>
          judge
        </button>
        {error && <span style={{ color: "#ff7777", fontSize: 12 }}>{error}</span>}
      </header>
      <div style={{ display: "flex" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <GraphView data={graph} selectedId={selectedId} onSelect={setSelectedId} />
          {inspection && (
            <InspectionDrawer
              inspection={inspection}
              onClose={() => setSelectedId(null)}
              onJump={setSelectedId}
              onDecide={(id, decision) => run(() => post("/api/decide", { channel_id: id, decision }))}
              onExpand={(id) => run(() => post("/api/expand", { channel_id: id }))}
              onEvaluate={(id, force) =>
                run(() => post("/api/judge", { channel_id: id, force }))
              }
              busy={busy}
            />
          )}
        </div>
        <CandidatePanel candidates={candidates} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}
