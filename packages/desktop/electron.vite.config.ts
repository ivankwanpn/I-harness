import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { devCspPlugin } from "./electron.csp.ts"

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ["@i-harness/sdk"] } } },
  // Electron sandboxed preload scripts cannot use ESM; emit one CJS bundle.
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: { plugins: [react(), tailwindcss(), devCspPlugin] },
})
