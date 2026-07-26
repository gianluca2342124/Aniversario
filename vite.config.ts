import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

process.env.WRANGLER_WRITE_LOGS ??= "false";
process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

export default defineConfig(async () => {
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [react(), cloudflare(), sites()],
    server: {
      watch: {
        useFsEvents: false,
        usePolling: process.env.CODEX_SANDBOX === "seatbelt",
      },
    },
    build: {
      sourcemap: true,
    },
  };
});
