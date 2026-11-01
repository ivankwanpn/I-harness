import type {UsageQuery,UsageRecord,UsagePrice,UsageSnapshot} from './types.js'
import type {UsageObservationV1} from './observation-types.js'
import type {ObservationEntity,ObservationProjection} from './observation-projection-types.js'
export type ObservationQuery=UsageQuery&{route?:'unknown'}
export interface UsagePopulation {observations:UsageObservationV1[];legacyRecords:UsageRecord[];prices:UsagePrice[];warnings:string[];observationNamespace:'absent'|'present'}
export interface ObservationCosts {pricedApiSends?:number;unpricedApiSends?:number;measuredEstimatedCostUsd?:number|null}
export type ObservationSummary=ObservationProjection['totals']&ObservationCosts
export interface ObservationGroup extends ObservationCosts {key:string;label:string;transportHandoffs:number;measuredSends:number;unavailableSends:number;measuredTokenSubtotal:number|null}
export type UsageV2Row=ObservationEntity
export interface UsageSnapshotV2 {
 kind:'usage-observation-snapshot';version:2;query:ObservationQuery;
 coverage:{recordingMode:'legacy'|'observations';observationStorage:'absent'|'present';status:'partial'|'unavailable';warnings:string[]};
 summary:ObservationSummary;daily:Array<{date:string;summary:ObservationSummary}>;models:ObservationGroup[];providers:ObservationGroup[];
 rows:UsageV2Row[];totalRows:number;page:number;pageSize:number;
 legacy:UsageSnapshot;prices:UsagePrice[];options:{workspaces:string[];projects:string[];providers:string[];models:string[]}
}
export type UsageConsumerView={kind:'observations';snapshot:UsageSnapshotV2}|{kind:'legacy-only';snapshot:UsageSnapshot;warnings:string[]}
