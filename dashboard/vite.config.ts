import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the FastAPI server runs separately; Vite proxies API and WebSocket calls to it.
// Override with API_URL=http://localhost:8100 npm run dev
const api = process.env.API_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from phones on the LAN
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
