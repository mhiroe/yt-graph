import { useEffect, useState } from "react";
import { GraphView, type GraphData } from "./graph/GraphView";

export function App() {
  const [health, setHealth] = useState<string>("checking…");
  const [graph, setGraph] = useState<GraphData>({ channels: [], edges: [] });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((b) => setHealth(b.ok ? `api ok (${b.service})` : "api error"))
      .catch(() => setHealth("api unreachable"));
    fetch("/api/graph")
      .then((r) => r.json())
      .then((b) => setGraph({ channels: b.channels ?? [], edges: b.edges ?? [] }))
      .catch(() => setGraph({ channels: [], edges: [] }));
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", color: "#eee", background: "#111", height: "100vh" }}>
      <header style={{ padding: "8px 16px" }}>
        <strong>yt-graph</strong> — {health} — {graph.channels.length} channels / {graph.edges.length} edges
      </header>
      <GraphView data={graph} />
    </div>
  );
}
