export type SearchStatus = "completed" | "limited" | "cancelled" | "timed-out" | "error"
export interface SearchQuery {
  pattern: string
  mode?: "regex" | "literal"
  case?: "sensitive" | "insensitive"
  before?: number
  after?: number
  includes?: string[]
  excludes?: string[]
  hidden?: boolean
  respectIgnore?: boolean
  regexEngine?: "default" | "pcre2"
  multiline?: boolean
  encoding?: "auto" | "utf8" | "utf16le" | "utf16be" | "windows1252" | "latin1"
  maxResults?: number
  maxResultBytes?: number
  timeoutMs?: number
}
export interface SearchMatch {
  path: string
  line: number
  text: string
  textTruncated?: boolean
  /** Zero-based UTF16 code units in BOM-stripped, CRLF-normalized text. */
  column?: number
  endLine?: number
  /** Exclusive zero-based UTF16 code unit position. */
  endColumn?: number
  context?: { line: number; text: string; textTruncated?: boolean }[]
  revision?: string
  encoding?: string
  readonly?: boolean
  external?: boolean
}
export interface SearchStats {
  candidateFiles: number
  attemptedFiles: number
  readFiles: number
  completedFiles: number
  eofFiles: number
  inputBytes: number
  engineRawBytes: number
  runnerRawBytes: number
}
export interface SearchResult {
  matches: SearchMatch[]
  status: SearchStatus
  partial: boolean
  truncated: boolean
  reasons: string[]
  error?: string
  diagnostics: string[]
  stats: SearchStats
  filters: Record<string, unknown>
  limits: Record<string, number>
}
