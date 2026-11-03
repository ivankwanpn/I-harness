import type { InstructionPolicy } from '@i-harness/settings'
import type { InstructionScope, InstructionService } from '@i-harness/instructions'
export interface InstructionHost { create(scope: InstructionScope): InstructionService; close(): Promise<void> }
export type SavedInstructionState = { kind: 'ready'; generation: string; policy: InstructionPolicy }
  | { kind: 'unavailable'; generation: string; reason: string }
export interface SavedInstructionPolicyPort {
  current(): SavedInstructionState
  ready(): Promise<void>
  subscribe(fence: () => void): () => void
}
export interface InstructionEnvironment {
  host: InstructionHost
  policy: SavedInstructionPolicyPort
  dispose(): void
  close(): Promise<void>
}
