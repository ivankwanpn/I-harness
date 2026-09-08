// Test double: emits a warning with the exact shape node:sqlite produces on
// Node 22 (ExperimentalWarning + "SQLite is an experimental feature...").
// Kept in a separate file so importing the real node:sqlite in a test would
// itself trigger the process-level warning at import time.
export function emitSqliteExperimentalWarning(): Error {
  const w = new Error("SQLite is an experimental feature and might change at any time")
  w.name = "ExperimentalWarning"
  return w
}
