import type { ToolExec } from '@i-harness/core-tools'
import type { ContextCapture } from '@i-harness/context-output'
import type { SessionView, SettlementFacts, ProducerFactOutcome } from '@i-harness/core-session'

export interface ResultSourceBinding { sessionId?: string; callId?: string; view?: SessionView; source?: SettlementFacts<ProducerFactOutcome>; descriptor?: ContextCapture['source'] }
const sources = new WeakMap<ToolExec, Readonly<ResultSourceBinding>>()
export function bindResultSource(exec: ToolExec, source: ResultSourceBinding): void { sources.set(exec, Object.freeze({ ...source, ...(source.descriptor ? { descriptor: Object.freeze({ ...source.descriptor }) } : {}) })) }
export function resultSourceBinding(exec: ToolExec): Readonly<ResultSourceBinding> | undefined { return sources.get(exec) }
