// Smoke check: run the seam self-check through tsx and propagate its exit.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");

const child = spawn(tsx, ["scripts/check-seams.ts"], { cwd: root, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
