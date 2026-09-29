import { useEffect, useRef } from "react";
import * as THREE from "three";

export type GraphChannel = { id: string; title: string; status: string };
export type GraphEdge = { src_channel_id: string; dst_channel_id: string; kind: string };
export type GraphData = { channels: GraphChannel[]; edges: GraphEdge[] };

const COLORS: Record<string, number> = {
  seed: 0xffcc44,
  candidate: 0x4488ff,
  accepted: 0x44dd88,
  rejected: 0x884444,
  later: 0x888888,
};

/** Minimal Three.js 3D graph: channels on a sphere layout, edges as lines. */
export function GraphView({ data }: { data: GraphData }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: THREE.Scene; group: THREE.Group } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 30);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);
    const group = new THREE.Group();
    scene.add(group);
    sceneRef.current = { scene, group };

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      group.rotation.y += 0.002;
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      cancelAnimationFrame(frame);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    ctx.group.clear();
    const radius = Math.max(6, data.channels.length);
    const pos = new Map<string, THREE.Vector3>();
    data.channels.forEach((ch, i) => {
      // Fibonacci sphere layout — deterministic, no physics needed for PoC.
      const phi = Math.acos(1 - (2 * (i + 0.5)) / Math.max(1, data.channels.length));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const v = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
      pos.set(ch.id, v);
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(ch.status === "seed" ? 0.9 : 0.5, 16, 16),
        new THREE.MeshBasicMaterial({ color: COLORS[ch.status] ?? COLORS.candidate }),
      );
      mesh.position.copy(v);
      mesh.userData.channelId = ch.id;
      ctx.group.add(mesh);
    });
    for (const e of data.edges) {
      const a = pos.get(e.src_channel_id);
      const b = pos.get(e.dst_channel_id);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      ctx.group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x555555 })));
    }
  }, [data]);

  return <div ref={mountRef} style={{ width: "100%", height: "calc(100vh - 40px)" }} />;
}
