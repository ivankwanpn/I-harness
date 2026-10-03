import type { SearchQuery, SearchResult, SearchStats, SearchMatch } from './search-types.ts'
import type { SearchLimits } from './options.mjs'
export interface SearchSnapshot { path:string; bytes:Uint8Array; revision?:string; encoding?:SearchQuery['encoding']; eof:boolean }
export interface MatcherRequest { argv:string[]; bytes:Uint8Array; signal:AbortSignal; maxBytes:number; onStdout(chunk:Buffer):void|'stop' }
export interface MatcherResponse { exitCode:number; stderr:string; stderrBytes:number; stopReason?:'consumer'|'output-limit'|'aborted'|'timeout'; limitReason?:string }
export function decodeSearchText(bytes:Uint8Array, encoding?:SearchQuery['encoding']): {text:string;encoding:string}
export function runByteSearch(options:{query: SearchQuery;rgPath:string;files:AsyncIterable<SearchSnapshot>;signal?:AbortSignal;limits?:SearchLimits;stats?:SearchStats;onProgress?:(event:{match?:SearchMatch;stats:SearchStats})=>void;matcher?:(request:MatcherRequest)=>Promise<MatcherResponse>}):Promise<SearchResult>
