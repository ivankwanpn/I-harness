import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ["@i-harness/sdk"] } } },
  // Electron sandboxed preload scripts cannot use ESM; emit one CJS bundle.
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: { plugins: [react()] },
})
