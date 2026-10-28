import type { SessionView } from '@i-harness/core-session'
import type { ObservedDocument } from './types.ts'

/** Trusted internal composition input; no public generic backend adapter. */
export interface ProcessReadStorage {
  capture(id: string, keys: readonly string[]): Promise<{
    initial: SessionView
    documents: ReadonlyMap<string, ObservedDocument>
    check(): Promise<void>
    finish(): Promise<void>
  }>
  captureManagedAuxiliary(id: string, keys: readonly string[]): Promise<{
    documents: ReadonlyMap<string, ObservedDocument>
    check(): Promise<void>
    finish(): Promise<void>
  }>
}
