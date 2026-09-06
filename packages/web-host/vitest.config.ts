// M49: Windows worker isolation. Process forks still hit intermittent
// ERR_IPC_CHANNEL_CLOSED during multi-file teardown, while one shared worker
// can crash native modules on repeated module isolation. vmThreads keeps each
// file in an isolated VM without the child-process IPC path; a 10-run stress
// gate passed after the WinACL backend became demand-loaded.
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    pool: "vmThreads",
    maxWorkers: 2,
  },
})
