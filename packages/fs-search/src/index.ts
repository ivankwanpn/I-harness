import { isAbsolute, resolve } from 'node:path'
import type { ExecService } from '@i-harness/exec'
import type { Tool, ToolExec } from '@i-harness/core-tools'
import type { SearchQuery, SearchResult, SearchMatch } from './search-types.ts'
import { normalizeSearchQuery, createSearchStats, createSearchResult, markSearchResult, addDiagnostic, finishSearchResult } from './options.mjs'
import { runScopedModelSearch } from './model-search.ts'
export { normalizeSearchQuery, createSearchStats } from './options.ts'
export type { SearchQuery, SearchResult, SearchMatch, SearchStats } from './search-types.ts'

let rgPathPromise: Promise<string> | undefined
export function resolveRgPath(): Promise<string> { return rgPathPromise ??= import('@vscode/ripgrep').then((m) => m.rgPath) }
export interface FsSearchToolDeps { exec: ExecService; workspace?: string }
export type GrepMatch = SearchMatch
export type GrepResult = SearchResult
export interface GlobResult extends Omit<SearchResult, 'matches'> { matches: string[] }
type ModelSearchArgs = SearchQuery & { path?: string; include?: string }

const properties = {
  pattern: { type: 'string', description: 'Non-empty, at most 4096 characters. Rust regex (default), literal text, or glob path pattern for glob. PCRE2 is an explicit advanced option.' },
  path: { type: 'string', description: 'File/directory to search under current standing policy; relative paths use the workspace.' },
  include: { type: 'string', description: 'Legacy optional glob filter of at most 512 characters, combined with includes.' },
  mode: { type: 'string', enum: ['regex','literal'], description: 'Regex or exact literal text.' }, case: { type: 'string', enum: ['sensitive','insensitive'] },
  before: { type: 'integer', minimum: 0, maximum: 10 }, after: { type: 'integer', minimum: 0, maximum: 10 },
  includes: { type: 'array', maxItems: 16, items: { type: 'string' }, description: 'Up to 16 non-empty glob patterns, each at most 512 characters; combined includes/excludes at most 4096.' }, excludes: { type: 'array', maxItems: 16, items: { type: 'string' }, description: 'Up to 16 non-empty glob patterns, each at most 512 characters; combined includes/excludes at most 4096. Exclusions win.' },
  hidden: { type: 'boolean', description: 'Include hidden names. Default false for grep, true for glob.' }, respectIgnore: { type: 'boolean', description: 'Use engine ignore filtering. Default true for grep, false for glob. Explicit paths and positive globs can override engine ignore rules.' },
  regexEngine: { type: 'string', enum: ['default','pcre2'] }, multiline: { type: 'boolean' }, encoding: { type: 'string', enum: ['auto','utf8','utf16le','utf16be','windows1252','latin1'] },
  maxResults: { type: 'integer', minimum: 1, maximum: 1000, description: 'Returned row cap; grep defaults 250, glob defaults 100.' },
  maxResultBytes: { type: 'integer', minimum: 4096, maximum: 262144, description: 'Combined serialized result bytes including metadata. Default 32768; explicit range 4096..262144.' },
  timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, description: 'Deadline including discovery, reads and matching. Default and hard maximum 30000ms.' },
}

async function search(kind: 'grep'|'glob', args: ModelSearchArgs, execution: ToolExec, deps: FsSearchToolDeps): Promise<SearchResult | GlobResult> {
  let query: Required<SearchQuery>
  try {
    const { path, include, ...input } = args
    if (path !== undefined && (typeof path !== 'string' || path.includes('\0'))) throw new Error('path must be a string without NUL')
    if (include !== undefined) input.includes = [...(input.includes ?? []), include]
    query = normalizeSearchQuery(input, { profile: kind })
  } catch (error) {
    const fallback = normalizeSearchQuery({ pattern: 'invalid' }, { profile: kind }), result = createSearchResult(fallback)
    result.error = String(error instanceof Error ? error.message : error).slice(0, 512); markSearchResult(result, 'invalid-query', 'error')
    return result
  }
  const partial = createSearchResult(query, createSearchStats())
  if (execution.abortSignal?.aborted) { markSearchResult(partial, 'aborted', 'cancelled'); return finishSearchResult(partial,query.maxResultBytes) }
  try {
    const rgPath = await resolveRgPath()
    const cwd = kind === 'glob' ? args.path === undefined ? deps.workspace : deps.workspace !== undefined && !isAbsolute(args.path) ? resolve(deps.workspace, args.path) : args.path : deps.workspace
    return await runScopedModelSearch({exec:deps.exec,rgPath,cwd,root:kind==='glob'?'.':args.path??'.',kind,query,signal:execution.abortSignal})
  } catch (error) { partial.error = String(error instanceof Error ? error.message : error).slice(0, 512); addDiagnostic(partial, partial.error); markSearchResult(partial, 'runner-error', 'error'); return finishSearchResult(partial, query.maxResultBytes) }
}

export function createFsSearchTools(deps: FsSearchToolDeps): Tool[] {
  return (['glob','grep'] as const).map((kind): Tool<ModelSearchArgs, SearchResult | GlobResult> => ({
    name: kind, description: kind === 'glob' ? 'Find files by glob with bounded discovery, cancellation, filtering and partial-result metadata. Discovery order; default 100 files and 32KiB result.' : 'Search admitted file snapshots using Rust regex or literal text. Typed case/context/globs/hidden/ignore/PCRE2/multiline/encoding options; cancellable 30s, 1000 candidates, 32MiB reads, 1MiB/file, default 250 rows and 32KiB result. Inspect status/reasons before treating empty or partial results as exhaustive.',
    inputSchema: { type: 'object', properties, required: ['pattern'], additionalProperties: false }, exposure: 'deferred', searchHint: kind === 'glob' ? 'find files by pattern' : 'search file contents by pattern', isReadOnly: true, isConcurrencySafe: true,
    execute: (args, execution) => search(kind, args, execution, deps),
  }))
}
