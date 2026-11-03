import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { devCspPlugin } from "./electron.csp.ts"
import { copyFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export default defineConfig({
  main: {
    plugins: [{
      name: "desktop-model-catalog",
      writeBundle(output) {
        if (!output.dir) throw new Error("Desktop main output directory is required")
        // Provider code is bundled into main/index.js; relocate its data too.
        // Both existing I_HARNESS_DIST modes keep a self-contained catalog.
        const catalog = fileURLToPath(new URL("../provider/src/model-catalog.json", import.meta.url))
        copyFileSync(catalog, join(output.dir, "..", "model-catalog.json"))
        copyFileSync(catalog, join(output.dir, "model-catalog.json"))
      },
    }],
    build: {
      externalizeDeps: { exclude: ["@i-harness/sdk", "@i-harness/fs-search", "@i-harness/usage-stats", "@i-harness/desktop-gateway"] },
      rollupOptions: { external: ["koffi"] },
    },
  },
  // Electron sandboxed preload scripts cannot use ESM; emit one CJS bundle.
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: { plugins: [react(), tailwindcss(), devCspPlugin] },
})
