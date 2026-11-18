import { defineConfig } from "vitest/config"

// These files drive real host processes, native terminals, a loopback model
// server and multi-minute compaction workloads. Running two files in one
// package concurrently on this Windows host makes the finite per-case budgets
// and instruction-observation settle windows race each other (measured
// CONTEXT_INPUT_STALE / watchdog churn in the long-growth files). Keep package
// files serial; workspace projects are already run with --workspace-concurrency=1.
export default defineConfig({ test: { fileParallelism: false } })
