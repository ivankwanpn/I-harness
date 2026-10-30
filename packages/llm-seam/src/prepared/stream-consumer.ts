// Trusted executor cooperation; bookkeeping admission remains private to llm-seam owners.
export { openOwnedPreparedStream, readDrainedOwnedExecutionConfirmation } from './stream-lifetime.ts'
export type { OwnedPreparedStreamInvocation } from './stream-lifetime.ts'
