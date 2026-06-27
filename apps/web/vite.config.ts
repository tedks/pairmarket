import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [".local", ".lan"],
  },
  build: {
    target: "es2024",
    sourcemap: true,
  },
});
