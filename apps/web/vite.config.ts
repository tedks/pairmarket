import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rpcTarget =
    env.VITE_PAIRMARKET_DEVSTACK_RPC_TARGET ?? "http://127.0.0.1:9000";
  const faucetTarget = (
    env.VITE_PAIRMARKET_DEVSTACK_FAUCET_TARGET ?? "http://127.0.0.1:9123"
  ).replace(/\/gas$/, "");

  return {
    plugins: [react()],
    server: {
      allowedHosts: [".local", ".lan"],
      proxy: {
        "/sui-rpc": {
          target: rpcTarget,
          changeOrigin: true,
          rewrite: () => "/",
        },
        "/sui-faucet": {
          target: faucetTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/sui-faucet/, ""),
        },
      },
    },
    build: {
      target: "es2024",
      sourcemap: true,
    },
  };
});
