import { canonicalJsonData } from '../serialization/json-data.ts'
import { isStrictFactData } from '../managed/capture.ts'
import { validManagedArtifactRef } from './validate.ts'
import type { FactReceipt } from '../managed/types.ts'
import type { ResultRetention } from './types.ts'

export const CODE_OUTPUT_RECORD_BYTES = 65536
export const CODE_OUTPUT_DIGEST_DOMAIN = 'ih.code-output-manifest.v1\0'
export interface CodeOutputHeader { version: 1; kind: 'code-output'; sessionId: string; cellId: string; sourceId: string }
export interface CodeOutputMember { seq: number; receipt: FactReceipt }
export interface CodeOutputDescriptor {
  kind: 'output'; ordinal: number; member: CodeOutputMember
  item: { kind: 'text'; retention: Extract<ResultRetention, { kind: 'artifact' | 'unavailable' }> }
    | { kind: 'image' | 'audio'; read: 'current-fact-required' }
}
export interface CodeOutputFooter {
  kind: 'seal'; count: number; digest: string; terminal: CodeOutputMember; status: 'completed' | 'failed' | 'terminated' | 'replanned' | 'interrupted' | 'policy-refused'
  store: CodeOutputMember | null; accepted: number; omitted: number; truncated: boolean
}
export type CodeOutputRecord = CodeOutputHeader | CodeOutputDescriptor | CodeOutputFooter
export interface CodeOutputCursor { artifactId: string; revision: string; cellId: string; sourceId: string; offset: number }
const size = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 1024
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Reflect.ownKeys(v).every(k => typeof k === 'string' && keys.includes(k) && Object.getOwnPropertyDescriptor(v,k)?.enumerable && Object.getOwnPropertyDescriptor(v,k)?.value !== undefined)
export function validCodeOutputMember(v: unknown): v is CodeOutputMember {
  if (!isStrictFactData(v) || !closed(v,['seq','receipt']) || !size(v.seq) || !closed(v.receipt,['owner','key','lastSeq','prefixDigest'])) return false
  const r = v.receipt, k = r.key
  return closed(r.owner,['sessionId','incarnation']) && id(r.owner.sessionId) && id(r.owner.incarnation)
    && closed(k,['batchId','firstSeq','count','previousPrefixDigest','batchDigest']) && id(k.batchId) && size(k.firstSeq) && size(k.count) && k.count > 0
    && hash(k.previousPrefixDigest) && hash(k.batchDigest) && size(r.lastSeq) && Number.isSafeInteger(k.firstSeq + k.count)
    && r.lastSeq === k.firstSeq + k.count - 1 && v.seq >= k.firstSeq && v.seq <= r.lastSeq && hash(r.prefixDigest)
}
export function validCodeOutputRecord(v: unknown): v is CodeOutputRecord {
  if (!isStrictFactData(v) || !v || typeof v !== 'object') return false
  const r = v as CodeOutputRecord
  if (r.kind === 'code-output') return closed(r,['version','kind','sessionId','cellId','sourceId']) && r.version === 1 && [r.sessionId,r.cellId,r.sourceId].every(id)
  if (r.kind === 'output') {
    if (!closed(r,['kind','ordinal','member','item']) || !size(r.ordinal) || !validCodeOutputMember(r.member)) return false
    const item = r.item
    if (item?.kind === 'image' || item?.kind === 'audio') return closed(item,['kind','read']) && item.read === 'current-fact-required'
    if (item?.kind !== 'text' || !closed(item,['kind','retention'])) return false
    const t = item.retention
    return t?.kind === 'artifact' ? closed(t,['kind','ref']) && validManagedArtifactRef(t.ref) && ['json-utf8-v1','text-utf8-v1'].includes(t.ref.codec)
      : t?.kind === 'unavailable' && closed(t,['kind','reason','observedEncodedBytes']) && ['quota','encoding','storage-refused','unsupported-owner','capture-canceled'].includes(t.reason)
        && (t.observedEncodedBytes === undefined || size(t.observedEncodedBytes))
  }
  return r.kind === 'seal' && closed(r,['kind','count','digest','terminal','status','store','accepted','omitted','truncated']) && size(r.count) && hash(r.digest)
    && validCodeOutputMember(r.terminal) && ['completed','failed','terminated','replanned','interrupted','policy-refused'].includes(r.status) && (r.store === null || validCodeOutputMember(r.store))
    && size(r.accepted) && size(r.omitted) && r.accepted >= r.count && r.omitted === r.accepted - r.count && typeof r.truncated === 'boolean'
}
export function encodeCodeOutputRecord(record: CodeOutputRecord): Buffer {
  if (!validCodeOutputRecord(record)) throw new TypeError('Invalid Code output record')
  const bytes = Buffer.from(canonicalJsonData(record) + '\n')
  if (bytes.length > CODE_OUTPUT_RECORD_BYTES) throw new TypeError('Code output record exceeds64KiB')
  return bytes
}
export function decodeCodeOutputRecord(bytes: Uint8Array): CodeOutputRecord {
  if (bytes.byteLength > CODE_OUTPUT_RECORD_BYTES) throw new Error('Code output record exceeds64KiB')
  const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  const record: unknown = JSON.parse(text)
  if (!validCodeOutputRecord(record) || !encodeCodeOutputRecord(record).equals(Buffer.from(bytes))) throw new Error('Noncanonical Code output record')
  return record
}
