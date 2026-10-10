import { defineConfig } from "vitest/config"

export default defineConfig({
  // These files exercise real Windows process owners and native search helpers.
  // Preserve their finite deadlines without competing host workloads per file.
  test: { fileParallelism: process.platform !== "win32" },
})
