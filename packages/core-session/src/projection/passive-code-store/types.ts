export type CodeStoreJsonValue = null | boolean | number | string | CodeStoreJsonValue[] | { [key: string]: CodeStoreJsonValue }
export type StoreEntries = readonly (readonly [string, CodeStoreJsonValue])[]
export type Cut = number
export type DataRow = { kind: 'put'; unit: number; key: number; value: number } | { kind: 'touch'; unit: number; key: number } | { kind: 'eligible'; unit: number; value: boolean }
export interface PassiveCodeStoreV1 {
  version: 1; units: number; keys: readonly string[]; values: readonly { valueJson: string }[]; rows: readonly DataRow[]
  cuts: readonly { end: number; overLimit?: true }[]; latest: Cut
  completed: readonly { turn: number; cut: Cut }[]; groups: readonly Cut[]
}
export type StoreReplay = { kind: 'value'; entries: StoreEntries } | { kind: 'limit-exceeded' }
export type DeferredValueSlot = { kind: 'local-descriptor'; slot: number; eventIndex: number; entryIndex: number; value: unknown } | { kind: 'inherited-json'; slot: number; valueJson: string }
export type CandidateRow = { kind: 'put'; unit: number; key: string; slot: number } | { kind: 'touch'; unit: number; key: string } | { kind: 'eligible'; unit: number; value: boolean }
export type CutKnowledge = { kind: 'unclassified' } | { kind: 'inherited-observation'; oldCut: Cut; outcome: 'value' | 'limit-exceeded' } | { kind: 'classified'; outcome: 'value' | 'limit-exceeded' }
export interface OwnedPassiveCandidates {
  units: number; rows: readonly CandidateRow[]; slots: readonly DeferredValueSlot[]
  cuts: readonly { end: number; knowledge: CutKnowledge }[]
  inherited?: { data: PassiveCodeStoreV1; toCandidate: readonly { oldCut: Cut; candidateCut: Cut }[] }
  latest: Cut; completed: readonly { turn: number; cut: Cut }[]; groups: readonly Cut[]
}
