import type { FactOwner, SessionView } from '@i-harness/core-session'
import type { SessionRequestContext } from '@i-harness/core-agent'

export interface ChildInstructionContextInput {
  readonly session: SessionView
  readonly factOwner: FactOwner
  readonly lifetime: { available(): boolean }
}

/** Session lifetime ownership; caller retains its document and plugin context. */
export interface ChildInstructionContext {
  readonly requestContext: SessionRequestContext
  retire(): void
  close(): Promise<void>
}

export type ChildInstructionContextFactory = (input: ChildInstructionContextInput) => ChildInstructionContext
