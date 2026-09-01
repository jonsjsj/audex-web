import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev proxy: the SPA calls same-origin /api/* in both dev and prod. In dev, Vite
// forwards that to the backend running on :8000 (uvicorn --reload), so there is no
// separate "API base URL" to configure per environment.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
