import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [".local", ".lan"],
    proxy: {
      "/sui-rpc": {
        target:
          process.env.VITE_PAIRMARKET_DEVSTACK_RPC_TARGET ??
          "http://127.0.0.1:9000",
        changeOrigin: true,
        rewrite: () => "/",
      },
      "/sui-faucet": {
        target:
          process.env.VITE_PAIRMARKET_DEVSTACK_FAUCET_TARGET ??
          "http://127.0.0.1:9123",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sui-faucet/, ""),
      },
    },
  },
  build: {
    target: "es2024",
    sourcemap: true,
  },
});
