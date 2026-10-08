import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { playbackBridge } from "./scripts/playbackBridge";

export default defineConfig({
  plugins: [react(), playbackBridge()],
  server: {
    port: 5174,
  },
});
