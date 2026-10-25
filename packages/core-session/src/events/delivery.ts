import { createHash } from 'node:crypto';
import { conversationId, conversationSeq } from './conversation.ts';
import { isStrictFactData } from '../managed/capture.ts';
import { canonicalJsonData } from '../serialization/json-data.ts';
export interface SubagentDeliveryKey {
  recipientSessionId: string;
  sourceNamespace: string;
  sourceId: string;
  resultRevision: string;
  kind: 'subagent';
}
export type DeliveryGenerationEvent = {
  type: 'agent/delivery-generation';
  version: 1;
  op: 'open';
  recipientSessionId: string;
  generationId: string;
  originInputSeq: number;
  seq?: number;
} | {
  type: 'agent/delivery-generation';
  version: 1;
  op: 'close';
  recipientSessionId: string;
  fenceId: string;
  reason: 'user-stop' | 'rewind';
  seq?: number;
};
export interface SubagentDeliverySourceEvent {
  type: 'agent/delivery-source';
  version: 1;
  kind: 'subagent';
  recipientSessionId: string;
  generationId: string;
  sourceNamespace: string;
  sourceId: string;
  callSeq: number;
  startSeq: number;
  seq?: number;
}
export interface DeliveryReceivedEvent {
  type: 'agent/delivery-received';
  version: 1;
  key: SubagentDeliveryKey;
  sourceSeq: number;
  terminalSeq: number;
  inputId: string;
  seq?: number;
}
export interface SubagentDeliveryLaunchDraft {
  recipientSessionId: string;
  generationId: string;
  sourceNamespace: string;
  sourceId: string;
  callSeq: number;
}
export type DeliveryLaunchPreparation = {
  kind: 'bound';
  binding: SubagentDeliveryLaunchDraft;
} | {
  kind: 'unavailable';
  reason: 'no-own-human-origin' | 'recipient-not-bound' | 'uncertified-call';
};
export interface SubagentDeliveryEvidence {
  sourceSeq: number;
  terminalSeq: number;
}
export interface DeliveryAdmissionReceipt {
  inputId: string;
  disposition: 'pending' | 'claimed' | 'cancelled' | 'suppressed';
  durability: 'durable' | 'nondurable';
}
export interface DeliveryCloseReceipt {
  fenceId: string;
  closeSeq: number;
  durability: 'durable' | 'nondurable';
}
export type DeliveryEvent = DeliveryGenerationEvent | SubagentDeliverySourceEvent | DeliveryReceivedEvent;
export const isDeliveryEventType = (type: unknown): boolean => ['agent/delivery-generation', 'agent/delivery-source', 'agent/delivery-received'].includes(type as string);
function closed(value: object, keys: string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);
}
export function validDeliveryKey(value: unknown): value is SubagentDeliveryKey {
  if (!value || typeof value !== 'object' || !isStrictFactData(value))
    return false;
  const k = value as SubagentDeliveryKey;
  return closed(k, ['recipientSessionId', 'sourceNamespace', 'sourceId', 'resultRevision', 'kind']) && k.kind === 'subagent'
    && [k.recipientSessionId, k.sourceNamespace, k.sourceId, k.resultRevision].every(conversationId);
}
export function deliveryInputId(key: Readonly<SubagentDeliveryKey>): string {
  return 'delivery-' + createHash('sha256').update(canonicalJsonData(['ih.delivery.v1', key.recipientSessionId, key.sourceNamespace, key.sourceId, key.resultRevision, 'subagent'])).digest('hex');
}
export function validDeliveryEvent(value: unknown): value is DeliveryEvent {
  if (!value || typeof value !== 'object' || !isStrictFactData(value))
    return false;
  const e = value as DeliveryEvent;
  if (e.version !== 1 || e.seq !== undefined && !conversationSeq(e.seq))
    return false;
  if (e.type === 'agent/delivery-received')
    return closed(e, ['type', 'version', 'seq', 'key', 'sourceSeq', 'terminalSeq', 'inputId']) && validDeliveryKey(e.key)
      && conversationSeq(e.sourceSeq) && conversationSeq(e.terminalSeq) && e.inputId === deliveryInputId(e.key);
  if (!('recipientSessionId' in e) || !conversationId(e.recipientSessionId))
    return false;
  if (e.type === 'agent/delivery-generation')
    return e.op === 'open'
      ? closed(e, ['type', 'version', 'seq', 'op', 'recipientSessionId', 'generationId', 'originInputSeq']) && conversationId(e.generationId) && conversationSeq(e.originInputSeq)
      : e.op === 'close' && closed(e, ['type', 'version', 'seq', 'op', 'recipientSessionId', 'fenceId', 'reason']) && conversationId(e.fenceId) && ['user-stop', 'rewind'].includes(e.reason);
  return e.type === 'agent/delivery-source' && closed(e, ['type', 'version', 'seq', 'kind', 'recipientSessionId', 'generationId', 'sourceNamespace', 'sourceId', 'callSeq', 'startSeq']) && e.kind === 'subagent'
    && [e.generationId, e.sourceNamespace, e.sourceId].every(conversationId) && conversationSeq(e.callSeq) && conversationSeq(e.startSeq);
}
