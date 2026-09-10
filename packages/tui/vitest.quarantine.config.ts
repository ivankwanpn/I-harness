// The quarantined-gate config: runs the files `vitest.config.ts` excludes.
//
// WHY a second config instead of a CLI flag: vitest APPENDS `--exclude` values
// to the config's array (it does not replace them), so `--exclude ""` cannot
// lift the quarantine. A config that simply does not list them can.
//
// Usage (never part of `pnpm -r test`):
//   pnpm --filter @i-harness/tui test:quarantine
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 2,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
})
