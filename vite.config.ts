import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client lives in src/client and builds to dist/client, which the Express
// server serves statically (SELEYA_CLIENT_DIR). In dev, /api is proxied to the
// running server.
export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7920",
    },
  },
});
