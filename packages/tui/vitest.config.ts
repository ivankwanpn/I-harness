import { defineConfig } from "vitest/config"

// forks pool: M31 lesson (Windows tinypool ERR_IPC_CHANNEL_CLOSED).
// packages/tui PTY tests spawn node-pty children in case-011/014.
//
// QUARANTINE (M61): case-027 is excluded from the DEFAULT run. It is the one
// harness file proven load-coupled — solo it passes in ~5s, but under ANY
// concurrent execution (70 packages in parallel, or even
// `--workspace-concurrency=1`) its `spawn-running` marker misses the 150s
// budget, because the 18 real-PTY files contend for the same machine. Leaving
// it in the default run makes `pnpm -r test` red for a reason that is not a
// code defect, which teaches people to ignore red — worse than the flake.
//
// It still RUNS, via its own gate: `pnpm --filter @i-harness/tui test:quarantine`
// (which uses vitest.quarantine.config.ts — a CLI `--exclude` cannot lift this,
// because vitest APPENDS CLI excludes to the config array rather than
// replacing it). Drag only from measurements showing the budget is actually met.
const QUARANTINED = ["test/harness/case-027.test.ts"]

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 2,
    // Defaults preserved explicitly so the quarantine is additive, not a
    // replacement of vitest's own excludes.
    exclude: ["**/node_modules/**", "**/dist/**", ...QUARANTINED],
  },
})
