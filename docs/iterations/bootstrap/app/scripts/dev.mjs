import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", name);

const children = [
  spawn(bin("tsx"), ["server/index.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" },
  }),
  spawn(bin("vite"), [], { cwd: root, stdio: "inherit" }),
];

const shutdown = () => {
  for (const c of children) c.kill("SIGINT");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
for (const c of children) c.on("exit", (code) => {
  if (code !== null && code !== 0) shutdown();
});
