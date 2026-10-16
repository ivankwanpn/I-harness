export * from "./types.ts"
export type { HookRegistryOptions, LoadedHandler, HookRegistry } from "./registry-types.ts"
export { resolveHooksConfigPath, loadHooksConfig } from "./configuration/load.ts"
export { createHookRegistry } from "./registry.ts"

// The last two are the user-layer grant surface. They are exported because the
// rule `loadHooksConfig` enforces is UNSATISFIABLE without them — a non-home
// handler can only be granted by a store a host constructs, and only located by
// the same path helper. The two TYPES stay internal to trust.ts and are not
// re-exported: `loadHooksConfig` takes its approvals STRUCTURALLY
// (`{ isApproved(sha256): boolean }`), so no host is obliged to name either.
//
// NOTE FOR THE NEXT EDITOR: this comment sits ABOVE the export block on purpose.
// `check-reachability.mjs` reads the braces literally, so a comment INSIDE them
// is parsed as a list of exported names — measured 2026-09-18, when a five-line
// comment in there produced four phantom rows and moved the digest. It reports
// those as NEW, so the failure is at least loud rather than silent.
export {
  sha256File,
  trustScriptPath,
  verifyHandlerTrust,
  resolveHookTrustPath,
  createHookTrustStore,
} from "./trust.ts"
export { runHookHandler, validateHookOutput, assertAllowed } from "./runner.ts"
export { sha256ClaudePluginTreeSync } from "./claude.ts"
