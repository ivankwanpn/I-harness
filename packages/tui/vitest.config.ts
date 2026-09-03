import { defineConfig } from "vitest/config"

// forks pool: M31 lesson (Windows tinypool ERR_IPC_CHANNEL_CLOSED).
// packages/tui PTY tests spawn node-pty children in case-011/014.
export default defineConfig({
  test: { pool: "forks", maxWorkers: 2 },
})
