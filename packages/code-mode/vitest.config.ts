import { defineConfig } from 'vitest/config'

// These cases drive real JSONL recovery flights (fsync, reconcile, dispose); the
// slowest exceed the 5 s default on a loaded machine, so use the same 30 s ceiling
// as the persistence, core-agent and sdk suites.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
