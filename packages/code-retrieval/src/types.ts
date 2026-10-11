export interface CodeEmbeddingConfig {
  provider: 'openai-compatible'|'ollama'; endpoint: string; model: string;
  credentialRef?: string; dimensions?: number;
}
export interface CodeRetrievalConfig {
  enabled: boolean; mode: 'lexical'|'hybrid'; autoRefresh: boolean;
  maxFiles: number; maxFileBytes: number; maxInputBytes: number; maxChunks: number;
  maxDiskBytes: number; maxSearchBytes: number; deadlineMs: number;
  ignorePatterns: string[]; embedding?: CodeEmbeddingConfig;
}
export interface CodeAccess { sessionId: string; signal?: AbortSignal }
export interface CodeFileSnapshot { sourceId: string; path: string; revision: string; text: string; complete: boolean }
export interface CodeHit {
  sourceId: string; path: string; revision: string; generation: number; text: string;
  startLine: number; endLine: number; startOffset: number; endOffset: number; score: number;
}
export interface CodeIndexDiagnostics {
  jobId: string; phase: 'opening'|'reading'|'embedding'|'publishing';
  elapsedMs: number; phaseElapsedMs: number; files: number; bytes: number; chunks: number;
}
export interface CodeRetrievalStatus {
  enabled: boolean; state: 'disabled'|'unindexed'|'indexing'|'ready'|'stopping'|'error';
  config: CodeRetrievalConfig; generation: number; files: number; chunks: number;
  storedBytes: number; activeJobs: number; jobId?: string; progress?: { files: number; bytes: number };
  partial: boolean; reasons: string[]; error?: string;
  /** Outcome of an indexing attempt, separate from committed completeness.
   * wait(jobId) retains the outcome of that specific job. */
  lastJob?: { jobId:string; outcome:'completed'|'cancelled'|'failed'; generation:number; reason?:string };
  /** Current attempt, or frozen diagnostics from the last settled attempt.
   * Counts describe staging; they do not replace the committed generation. */
  indexDiagnostics?: CodeIndexDiagnostics;
  /** Measured counters for this service lifetime. Missing provider token usage
   * increments unreportedRequests; it is never presented as zero token use. */
  metrics?: { embeddingRequests:number; embeddingCacheHits:number; reportedInputTokens:number; unreportedRequests:number };
  /** Current-source checks from the latest completed search, distinct from
   * durable index completeness. This is not a scan of every indexed file. */
  sourceHealth?: { scope:'last-search'; state:'unchecked'|'current'|'degraded'; generation:number; checkedFiles:number; refusedFiles:number; reasons:string[]; checkedAt:number };
}
export type CodeSourceRefusal = 'source-unavailable'|'source-changed'|'source-path-unavailable'|'source-ignored'|'source-policy-incomplete'|'source-content-changed'|'source-content-incomplete'|'source-validation-limit'|'source-validation-failed'|'stale-or-inaccessible-source';
export type CodeSourceValidation = { valid:true } | { valid:false; reason:CodeSourceRefusal; code?:string };
export interface CodeSearchResult { hits: CodeHit[]; mode: 'lexical'|'hybrid'; partial: boolean; reasons: string[]; generation: number; diagnostics?: { reason:CodeSourceRefusal; code?:string; count:number }[] }
export interface CodeSnapshotReader {
  /** Capture the actual source set before scheduling a full index. */
  indexSourceIds?(): string[];
  /** Recheck current source authority before another session can join and
   * manage an existing index lifetime. The scope belongs to that job. */
  authorizeIndex?(access:CodeAccess,input:{sourceIds:string[]}): Promise<void>;
  snapshots(access: CodeAccess, options: { sourceIds?: string[]; config: CodeRetrievalConfig }): AsyncIterable<CodeFileSnapshot>;
  revalidate(access: CodeAccess, hit: CodeHit): Promise<boolean|CodeSourceValidation>;
  status?(): { partial: boolean; reasons: string[] };
}
export interface CodeRetrievalService {
  configure(patch: Partial<CodeRetrievalConfig>): Promise<CodeRetrievalStatus>;
  status(): CodeRetrievalStatus;
  startIndex(access: CodeAccess, options?: { sourceIds?: string[]; force?: boolean }): Promise<{ jobId: string }>;
  wait(jobId: string): Promise<CodeRetrievalStatus>;
  search(access: CodeAccess, query: { query: string; sourceIds?: string[]; pathPrefix?: string; limit?: number; maxBytes?: number }): Promise<CodeSearchResult>;
  cancel(): Promise<CodeRetrievalStatus>;
  clear(): Promise<CodeRetrievalStatus>;
  close(): Promise<void>;
}
export interface CodeRetrievalOptions {
  root: string; workspaceId: string; reader: CodeSnapshotReader; config?: Partial<CodeRetrievalConfig>;
  resolveCredential?: (ref: string) => string|undefined; fetch?: typeof globalThis.fetch;
  /** Connect this lifetime to an owning session's shared job management.
   * Human settings jobs may have no session registry. Registration failures
   * reject admission before any index work starts. */
  registerJob?: (access:CodeAccess,job:{jobId:string;cancel():void}) => {finish(status:'completed'|'killed'|'error',output:string):void}|undefined;
}
