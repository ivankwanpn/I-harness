import { defineConfig } from "vitest/config"

// M25 (spec §2.1): the e2e layer config. vitest 3.x default include only
// matches *.test.ts / *.spec.ts; the M25 e2e files are named *.e2e.ts and
// must be included explicitly (same lesson as
// packages/sandbox-windows-acl/vitest.config.ts — without this the e2e run
// silently collects nothing).
//
// This config lives INSIDE e2e/ and is passed explicitly via
// `vitest run e2e/ --config e2e/vitest.config.ts` — a repo-root
// vitest.config.ts would be discovered by EVERY package's `vitest run`
// (config resolution walks up from the package cwd) and would replace their
// default test include, breaking `pnpm -r test` (verified empirically).
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    // Real-process spawns (tsx bootstrap + real CLI) and real tool runs need
    // far more than vitest's 5s default.
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
