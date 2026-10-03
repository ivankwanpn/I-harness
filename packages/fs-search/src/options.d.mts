import type { SearchQuery, SearchResult, SearchStats, SearchStatus } from './search-types.ts'
export type SearchLimits = { maxCandidates?: number; maxInputBytes?: number; maxFileBytes?: number; maxEngineRawBytes?: number; maxRunnerRawBytes?: number; maxWorkers?: number }
export const HARD_LIMITS: Readonly<Required<SearchLimits>>
export function normalizeSearchQuery(query: SearchQuery, options?: {profile?: 'human'|'grep'|'glob'}): Required<SearchQuery>
export function createSearchStats(): SearchStats
export function normalizeLimits(limits?: SearchLimits): Required<SearchLimits>
export function createSearchResult(query: Required<SearchQuery>, stats?: SearchStats, limits?: Required<SearchLimits>): SearchResult
export function markSearchResult(result: SearchResult, reason: string, status?: SearchStatus): void
export function addDiagnostic(result: SearchResult, text: unknown): void
export function cropText(text: string, maxBytes?: number): {text:string;textTruncated?:boolean}
export function finishSearchResult(result: SearchResult, maxBytes: number): SearchResult
