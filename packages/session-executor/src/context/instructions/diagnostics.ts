import type { InstructionSourceStatus } from '@i-harness/instructions'
export interface InstructionPublication {
  readonly fingerprint: string; readonly sourceRevision: number; readonly policyGeneration: string; readonly authorityRevision: string
  readonly enabled: boolean; readonly maxBytes: number; readonly bytes: number
  readonly scope: { readonly cwd: string; readonly roots: readonly string[] }
  readonly sources: readonly InstructionSourceStatus[]
}
export interface InstructionReport {
  readonly state: 'not-published' | 'ready' | 'stale' | 'pending' | 'unavailable' | 'revoked'
  readonly effectivePolicy?: { readonly generation: string; readonly enabled: boolean; readonly maxBytes: number }
  readonly publication?: InstructionPublication
}
