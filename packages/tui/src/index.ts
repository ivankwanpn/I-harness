// @i-harness/tui — M37a public surface (filled at G4, the wheel).
// The single import surface for hosts (apps/tui + future --attach hosts):
// the app loop + its option/state types, the scrollback engine, the embedded
// backend (bridge + mock-first factory), and the shared contracts.
// Runtime dependencies: workspace packages only (@i-harness/tui-core /
// @i-harness/session-executor / @i-harness/core-session — see package.json).

export { TuiApp } from "./app/loop.ts"
export type { TuiAppOptions, InputSource } from "./app/loop.ts"
export type { TuiAppState } from "./app/present.ts"
export { createScrollbackEngine } from "./scrollback/engine.ts"
export type { ScrollbackEngineOptions } from "./scrollback/engine.ts"
export { createEmbeddedBackend, defaultEmbeddedFactory } from "./backend/embedded.ts"
export type { EmbeddedOptions, EmbeddedFactoryOptions } from "./backend/embedded.ts"
export { toolKindOf } from "./contracts.ts"
export type {
  BackendClient,
  DisplayLine,
  ScrollbackEngine,
  ScrollbackSearchResult,
  SessionSummary,
  StyledRun,
  TextStyle,
  TodoItem,
  ToolKind,
  TuiEvent,
} from "./contracts.ts"
