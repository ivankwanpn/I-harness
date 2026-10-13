import type { resolveCompactSpec } from "../config.ts"
import type { Session } from "@i-harness/core-session"
import type { createCompactionEngine, CompactionResult } from "../index.ts"

// Type-only views of the original dependency object. Keep the object itself:
// optional callbacks are methods and property accessors remain live.
export type SummaryDependencies = Pick<Parameters<typeof createCompactionEngine>[0], "model" | "requestShape" | "maxOutputTokens" | "telemetry">
export type CompactPass = (session: Session, allowPruneOnly: boolean, instructions?: string, reason?: "auto" | "manual") => Promise<CompactionResult>

// The same resolved settings inferred at the original factory boundary.
export type CompactSettings = ReturnType<typeof resolveCompactSpec>
