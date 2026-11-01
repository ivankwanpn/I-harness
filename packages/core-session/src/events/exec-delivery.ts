import { conversationId, conversationSeq } from './conversation.ts';
import { isStrictFactData } from '../managed/capture.ts';
import { validManagedArtifactRef } from '../results/validate.ts';
import type { ResultDependency, ResultOutcome } from '../results/types.ts';

export interface ExecDeliverySourceEvent {
  type: 'agent/delivery-source'; version: 1; kind: 'exec';
  recipientSessionId: string; generationId: string;
  sourceNamespace: 'exec'; sourceId: string; callSeq: number;
  delivery: 'tool' | 'parent'; seq?: number;
}
export interface ExecDeliveryHandoffEvent {
  type: 'agent/delivery-handoff'; version: 1; kind: 'exec'; sourceSeq: number; seq?: number;
}
type ExecTerminalBase = { type: 'exec/end'; version: 1; sourceSeq: number; instanceId: string; seq?: number };
export type ExecTerminalEvent = ExecTerminalBase & ({
  execution: { dispatch: 'dispatched'; outcome: ResultOutcome };
  frameSourceId: string; dependency: ResultDependency; exitCode: number | null; timedOut: boolean;
} | {
  execution: { dispatch: 'not-dispatched' | 'unknown'; outcome: 'unknown' };
  reason: 'launch-refused' | 'launch-unknown';
});
export type ExecDeliveryEvent = ExecDeliverySourceEvent | ExecDeliveryHandoffEvent | ExecTerminalEvent;
const closed = (value: unknown, keys: readonly string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
  && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);

/** These facts contain scalar routing and an original dependency, never output bodies. */
export function validExecDeliveryEvent(value: unknown): value is ExecDeliveryEvent {
  if (!value || typeof value !== 'object' || !isStrictFactData(value)) return false;
  const event = value as ExecDeliveryEvent;
  if (event.version !== 1 || event.seq !== undefined && !conversationSeq(event.seq)) return false;
  if (event.type === 'agent/delivery-source') return closed(event, ['type', 'version', 'kind', 'recipientSessionId', 'generationId', 'sourceNamespace', 'sourceId', 'callSeq', 'delivery', 'seq'])
    && event.kind === 'exec' && event.sourceNamespace === 'exec' && [event.recipientSessionId, event.generationId, event.sourceId].every(conversationId)
    && conversationSeq(event.callSeq) && ['tool', 'parent'].includes(event.delivery);
  if (event.type === 'agent/delivery-handoff') return closed(event, ['type', 'version', 'kind', 'sourceSeq', 'seq']) && event.kind === 'exec' && conversationSeq(event.sourceSeq);
  if (event.type !== 'exec/end' || !conversationSeq(event.sourceSeq) || !conversationId(event.instanceId) || !event.execution
      || !closed(event.execution, ['dispatch', 'outcome'])) return false;
  if (event.execution.dispatch !== 'dispatched') return closed(event, ['type', 'version', 'sourceSeq', 'instanceId', 'execution', 'reason', 'seq'])
    && ['not-dispatched', 'unknown'].includes(event.execution.dispatch) && event.execution.outcome === 'unknown'
    && 'reason' in event && event.reason === (event.execution.dispatch === 'not-dispatched' ? 'launch-refused' : 'launch-unknown');
  if (!('dependency' in event) || !closed(event, ['type', 'version', 'sourceSeq', 'instanceId', 'execution', 'frameSourceId', 'dependency', 'exitCode', 'timedOut', 'seq'])
      || !['succeeded', 'failed', 'canceled', 'unknown'].includes(event.execution.outcome)
      || !conversationId(event.frameSourceId) || !event.frameSourceId.startsWith('process:') || event.frameSourceId.length <= 8
      || event.exitCode !== null && !Number.isSafeInteger(event.exitCode) || typeof event.timedOut !== 'boolean') return false;
  const dependency = event.dependency;
  if (!dependency || !closed(dependency, ['kind', 'sourceId', 'retention']) || dependency.kind !== 'exec-frames' || dependency.sourceId !== event.frameSourceId || !dependency.retention) return false;
  const retention = dependency.retention;
  if (retention.kind === 'artifact') return closed(retention, ['kind', 'ref']) && validManagedArtifactRef(retention.ref) && retention.ref.codec === 'exec-frames-v1';
  return retention.kind === 'unavailable' && closed(retention, ['kind', 'reason', 'observedEncodedBytes'])
    && ['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason)
    && (retention.observedEncodedBytes === undefined || Number.isSafeInteger(retention.observedEncodedBytes) && retention.observedEncodedBytes >= 0);
}

export function eligibleExecTerminal(event: ExecTerminalEvent): boolean {
  return event.execution.dispatch === 'dispatched' && ['succeeded', 'failed'].includes(event.execution.outcome)
    && 'dependency' in event && event.exitCode !== null && event.dependency.retention.kind === 'artifact'
    && ['complete', 'source-limited'].includes(event.dependency.retention.ref.completeness);
}
