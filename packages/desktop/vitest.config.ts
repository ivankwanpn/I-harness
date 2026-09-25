import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  // UI tests opt into jsdom per file; the rest (subprocess e2e) need Node globals.
  test: { environment: "node" },
})
