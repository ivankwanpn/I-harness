// @i-harness/sdk — external stdio SDK (R-C4). Protocol + client live here;
// the SessionService-backed server is a separate entry (`@i-harness/sdk/server`)
// so client-only consumers never load the engine.
export * from "./protocol.ts"
// M68 batch A: the host-side outbound bound (apps/cli wires it to stdout).
export { createBoundedWriter, DEFAULT_WRITE_BOUND_BYTES } from "./bounded-writer.ts"
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
