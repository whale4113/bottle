import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", ws: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 3000,
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
