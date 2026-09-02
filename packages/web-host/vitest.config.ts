// M31: web-host vitest pool — the default `threads`(tinypool) pool is
// flaky on Windows (`ERR_IPC_CHANNEL_CLOSED` / "Channel closed" worker
// teardown, seen repeatedly across M27-M31; README "known vitest worker
// flake" note). `forks` uses child processes, eliminating the IPC channel
// teardown race at the cost of slightly slower first startup — worth it
// for a deterministic gate.
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "forks",
    // web-host suites are fast (< 500 ms/file); a handful of files each
    // need only one fork. Prevents many-process spawn storms.
    maxWorkers: 2,
  },
})
