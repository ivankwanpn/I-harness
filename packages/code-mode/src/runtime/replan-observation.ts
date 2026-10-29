import type { InstructionReplanError } from '@i-harness/core-tools'
import type { CodeModeObservation } from '../types.ts'

const observations = new WeakMap<CodeModeObservation, InstructionReplanError>()
export function bindObservationReplan(observation: CodeModeObservation, error: InstructionReplanError): void { observations.set(observation, error) }
export function originalObservationReplan(observation: CodeModeObservation): InstructionReplanError | undefined { return observations.get(observation) }
