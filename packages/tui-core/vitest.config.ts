import { defineConfig } from "vitest/config"

// forks pool: M31 lesson — tinypool threads on Windows hit ERR_IPC_CHANNEL_CLOSED.
// tui-core spawns real PTYs (node-pty) in tests; child-process workers keep them isolated.
export default defineConfig({
  test: { pool: "forks", maxWorkers: 2 },
})
