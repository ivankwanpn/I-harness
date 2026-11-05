import { defineConfig } from 'vitest/config'

// The cancel/stop cases wait for real receipts and CLI subprocesses; the slowest
// exceed the 5 s default on a loaded machine. The actual fork routes also drive
// real CLI-host preparation and adopt flights that take ~24 s alone and exceed
// 30 s under the full-suite load, so the ceiling is 60 s here.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
