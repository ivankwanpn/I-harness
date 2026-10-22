import type { LLMMessage } from '../projection/types.ts'
import type { ManagedArtifactRef, ResultExecution } from '../results/types.ts'
import type { ConversationProvenance } from './types.ts'

export type Digest = string; // closed codec requires lowercase SHA256, exactly64 chars
export type SeedSourceLabel = {kind:'session';sessionId:string}|{kind:'anonymous'};
export type SeedOrigin =
  | { kind: 'session'; sessionId: string; revision: Digest } // observation, not freshness
  | { kind: 'anonymous'; contentDigest: Digest };
export type TurnInterval = readonly [first: number, last: number]; // positive, inclusive
export interface SeedTurnDomain {
  total: number; completed: readonly TurnInterval[]; unframedPrefix: boolean;
}
export type TurnExtent = { kind: 'framed'; first: number; last: number }
  | { kind: 'unframed' };
export type SeedSelection = { kind: 'none' } | { kind: 'all' }
  | { kind: 'last-turns'; count: number }
  | { kind: 'completed'; atSeq?: number };
export type SeedRefusal = 'invalid-selection' | 'source-unsupported' | 'ambiguous-boundary'
  | 'no-completed-boundary' | 'straddling-group' | 'unsafe-input-component'
  | 'invalid-seed' | 'source-changed';
export interface SeedOriginAddress { origin: number; seq: number; part: string }
export interface SeedOmission {
  extent: TurnExtent;
  source: readonly SeedOriginAddress[]; digest: Digest;
  state: 'open' | 'unresolved'; calls: number; relatedInputs: readonly number[];
}
export interface SeedArtifact {
  ref: ManagedArtifactRef; // unique by full immutable identity in this table
  origins: readonly SeedOriginAddress[];
  uses:readonly ({kind:'result'}|{kind:'dependency-catalog';count:number})[];
}
export interface BootstrapDependencyRequest {
  operationId: string; targetSessionId: string; manifestDigest: Digest;
  sourceSessionId: string; artifacts: readonly SeedArtifact[];
}
export type BootstrapDependencyOutcome = {kind:'confirmed';closureDigest:Digest}
  | {kind:'blocked';reason:'unknown'|'unavailable'|'conflict'|'policy'};
export type SeedSourceRetention =
  { kind: 'inline-observation'; encodedBytes: number; sourceValueDigest?:Digest }
  | { kind: 'artifact'; artifact: number }
  | { kind: 'unavailable'; reason: 'quota' | 'encoding' | 'storage-refused'
      | 'unsupported-owner' | 'capture-canceled'; observedEncodedBytes?: number };
export interface SeedResultBase {
  message:number;source:readonly SeedOriginAddress[];
  media: readonly { message: number; part: number }[];
}
export type SeedResult=
  | (SeedResultBase & {kind:'legacy';isError?:true})
  | (SeedResultBase & {kind:'envelope';execution:ResultExecution;
      sourceRetention:SeedSourceRetention;
      dependencies?:{kind:'catalog';artifact:number;count:number}
        |{kind:'unavailable';reason:Extract<SeedSourceRetention,
          {kind:'unavailable'}>['reason'];count:number}});
export interface SeedCall {
  id: string; name: string; assistantMessage: number; call: number;
  result: number; outcome: 'success' | 'error' | 'not-dispatched';
  source: readonly SeedOriginAddress[];
}
export interface SeedSourceProvenance {
  origin:number;kind:ConversationProvenance['kind'];
  authority:ConversationProvenance['authority'];scope:'turn'|'session';
  producer?:string;
}
export interface SeedItemBase {
  extent: TurnExtent;
  scope: 'turn' | 'session'; producer?: string;
  origins: readonly SeedOriginAddress[];
  sourceProvenance:readonly SeedSourceProvenance[];
  messages: readonly LLMMessage[];
}
export type SeedItem=
  | (SeedItemBase & {kind:'input';input:{raw:readonly SeedOriginAddress[];
    derivedContext: readonly SeedOriginAddress[];
    media: readonly { message: number; part: number }[];
    omittedWork?:number}})
  | (SeedItemBase & {kind:'summary'})
  | (SeedItemBase & {kind:'exchange';calls:readonly SeedCall[];
      results:readonly SeedResult[];
      sourceAcceptance:'explicit'|'legacy-inferred'|'inherited-observation'});
export interface SeedGroup { extent: TurnExtent; items: readonly SeedItem[] }
export interface SemanticSeedV1 {
  version: 1; origins: readonly SeedOrigin[]; selection: Exclude<SeedSelection,
    { kind: 'none' }>; turns: SeedTurnDomain;
  omissions: readonly SeedOmission[]; artifacts: readonly SeedArtifact[];
  groups: readonly SeedGroup[];
}
export type SeedExport = { kind: 'none' }
  | { kind: 'seed'; seed: SemanticSeedV1; digest: Digest;
      sourceObservationDigest:Digest }
  | { kind: 'refused'; reason: SeedRefusal };
