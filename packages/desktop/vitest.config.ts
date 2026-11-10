import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  // UI tests opt into jsdom per file; the rest (subprocess e2e) need Node globals.
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Match verify:all's resource budget. Real gateway, native filesystem and
    // jsdom fixtures share this package; CPU-count fan-out starves their work.
    maxWorkers: 2,
    minWorkers: 1,
  },
})
