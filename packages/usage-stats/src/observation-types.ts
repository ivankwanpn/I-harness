/** Inactive observation DTO. These scalar observations are not authority to send or bill. */
export type ObservationOrigin =
  | { kind: 'input' | 'predecessor' | 'command'; seq: number }
  | { kind: 'tool' | 'code'; seq: number; parentActionId: string }
  | { kind: 'delegated-input'; ref: 'admitted'; seq: number; inputId: string }
  | { kind: 'delegated-input'; ref: 'inbox'; seq: number; messageId: string }
  | { kind: 'observation-input'; seq: number; inputId: string }
export type ObservationLane = 'main' | 'recovery' | 'summary' | 'auxiliary'
type Identity = { ownerSessionId: string; actionId: string }
type Fact = Identity & { factSeq: number }
type Candidate = { semanticId: string; payloadId: string; payloadKind: 'http-json-body' | 'sdk-command-estimate' | 'audio-json-body' }
type Counters = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; inputTokenSemantics?: 'includes-cache' | 'excludes-cache' }
type Attribution = { providerId: string; modelId: string; workspace: string; projectId?: string; billing: 'api' | 'subscription' | 'unknown' }
export type UsageFactObservation =
  | (Fact & { type: 'action-open'; purpose: 'main' | 'manual' | 'approval' | 'title' | 'media'; origin: ObservationOrigin; startedAt: number; expiresAt: number })
  | (Fact & { type: 'action-bind'; executionDomain: 'physical' | 'local-test' })
  | (Fact & { type: 'action-close'; disposition: 'accepted' | 'completed' | 'failed' | 'stopped' | 'expired' | 'exhausted' })
  | (Fact & Candidate & { type: 'attempt-reserve'; attemptId: string; ordinal: number; lane: ObservationLane; cause: 'initial' | 'retry' | 'piece' | 'changed-input' | 'auxiliary'; incarnation: string })
  | (Fact & Candidate & { type: 'attempt-rebind'; attemptId: string; rebind: number; incarnation: string })
  | (Fact & { type: 'attempt-settle'; attemptId: string; disposition: 'unsent' | 'issued' | 'unknown' | 'completed' | 'failed'; sendId?: string })
  | (Fact & { type: 'local-invocation'; localInvocationId: string; ordinal: number; lane: ObservationLane; incarnation: string })
  | (Fact & { type: 'local-settle'; localInvocationId: string; disposition: 'unsent' | 'completed' | 'failed' })
export type UsageLiveObservation =
  | (Identity & Candidate & { type: 'handoff'; attemptId: string; sendId: string; rebind: number; incarnation: string; attribution?:Attribution })
  | (Identity & Attribution & Counters & { type: 'usage-snapshot'; attemptId: string; sendId: string; snapshotOrdinal: number; validity: 'valid' | 'invalid'; terminalCoverage: 'complete' | 'partial' | 'unknown' })
  | (Attribution & Counters & { type: 'unattributed-invocation'; validity: 'valid' | 'invalid'; terminalCoverage: 'complete' | 'partial' | 'unknown' })
export type UsageObservationV1 = { kind: 'usage-observation'; version: 1; observationId: string; observedAt: number } & (
  | { source: 'journal-fact' | 'memory-committed'; observation: UsageFactObservation }
  | { source: 'live-owner'; observation: UsageLiveObservation }
)
