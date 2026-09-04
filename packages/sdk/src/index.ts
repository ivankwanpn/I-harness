// @i-harness/sdk — external stdio SDK (R-C4). Protocol + client live here;
// the SessionService-backed server is a separate entry (`@i-harness/sdk/server`)
// so client-only consumers never load the engine.
export * from "./protocol.ts"
export {
  HarnessClient,
  HarnessSession,
  createHarnessClient,
  runHarness,
  SdkConnectionError,
  SdkRunError,
  type ServerInfo,
  type RunInput,
  type RunResult,
  type QueueState,
  type HistoryOptions,
} from "./client.ts"
