export const HARD_LIMITS = Object.freeze({ maxCandidates: 1000, maxInputBytes: 32 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxEngineRawBytes: 1024 * 1024, maxRunnerRawBytes: 1024 * 1024, maxWorkers: 4 })
const fields = new Set(['pattern','mode','case','before','after','includes','excludes','hidden','respectIgnore','regexEngine','multiline','encoding','maxResults','maxResultBytes','timeoutMs'])
const integer = (value, fallback, min, max, name) => {
  const n = value === undefined ? fallback : value
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`)
  return n
}
const choice = (value, fallback, choices, name) => {
  const v = value === undefined ? fallback : value
  if (!choices.includes(v)) throw new Error(`unsupported ${name}`)
  return v
}
const boolean = (value, fallback, name) => {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value ?? fallback
}
export function normalizeSearchQuery(query, { profile = 'grep' } = {}) {
  if (!['human','grep','glob'].includes(profile)) throw new Error('unknown search profile')
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('search query must be an object')
  for (const field of Object.keys(query)) if (!fields.has(field)) throw new Error(`unsupported search option: ${field}`)
  if (typeof query.pattern !== 'string' || query.pattern.length === 0 || query.pattern.length > 4096 || query.pattern.includes('\0')) throw new Error('pattern must be non-empty and at most 4096 characters without NUL')
  if (profile === 'glob' && query.pattern.trim().length === 0) throw new Error('glob pattern must be non-empty')
  let filterChars = 0
  const filters = (patterns, name) => {
    const list = patterns ?? []
    if (!Array.isArray(list) || list.length > 16 || list.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 512 || p.includes('\0'))) throw new Error(`${name} must contain at most 16 non-empty patterns of at most 512 characters`)
    filterChars += list.reduce((n, p) => n + p.length, 0)
    return [...list]
  }
  const includes = filters(query.includes, 'includes'), excludes = filters(query.excludes, 'excludes')
  if (filterChars > 4096) throw new Error('combined filter patterns exceed 4096 characters')
  return {
    pattern: query.pattern, mode: choice(query.mode, 'regex', ['regex','literal'], 'mode'), case: choice(query.case, 'sensitive', ['sensitive','insensitive'], 'case'),
    before: integer(query.before, 0, 0, 10, 'before'), after: integer(query.after, 0, 0, 10, 'after'), includes, excludes,
    hidden: boolean(query.hidden, profile === 'glob', 'hidden'), respectIgnore: boolean(query.respectIgnore, profile !== 'glob', 'respectIgnore'),
    regexEngine: choice(query.regexEngine, 'default', ['default','pcre2'], 'regexEngine'), multiline: boolean(query.multiline, false, 'multiline'),
    encoding: choice(query.encoding, 'auto', ['auto','utf8','utf16le','utf16be','windows1252','latin1'], 'encoding'),
    maxResults: integer(query.maxResults, profile === 'glob' ? 100 : 250, 1, 1000, 'maxResults'),
    maxResultBytes: integer(query.maxResultBytes, profile === 'human' ? 256 * 1024 : 32 * 1024, 4096, 256 * 1024, 'maxResultBytes'), timeoutMs: integer(query.timeoutMs, 30000, 100, 30000, 'timeoutMs'),
  }
}
export function createSearchStats() { return { candidateFiles: 0, attemptedFiles: 0, readFiles: 0, completedFiles: 0, eofFiles: 0, inputBytes: 0, engineRawBytes: 0, runnerRawBytes: 0 } }
export function normalizeLimits(limits = {}) {
  const result = { ...HARD_LIMITS }
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in HARD_LIMITS)) throw new Error(`unsupported search limit: ${key}`)
    result[key] = integer(value, HARD_LIMITS[key], 1, HARD_LIMITS[key], key)
  }
  return result
}
export function createSearchResult(query, stats = createSearchStats(), limits = normalizeLimits()) {
  return { matches: [], status: 'completed', partial: false, truncated: false, reasons: [], diagnostics: [], stats, filters: { hidden: query.hidden, respectIgnore: query.respectIgnore, includes: query.includes, excludes: query.excludes, ignorePolicy: 'engine', ordering: 'discovery/arrival' }, limits: { ...limits, maxResults: query.maxResults, maxResultBytes: query.maxResultBytes, timeoutMs: query.timeoutMs } }
}
export function markSearchResult(result, reason, status = 'limited') {
  if (!result.reasons.includes(reason)) result.reasons.push(reason)
  result.partial = true
  if (status === 'limited') result.truncated = true
  if (result.status === 'completed' || status === 'error' || status === 'cancelled' || status === 'timed-out') result.status = status
}
export function addDiagnostic(result, text) {
  if (result.diagnostics.length < 16) result.diagnostics.push(cropText(String(text), 512).text)
}
export function cropText(text, maxBytes = 2048) {
  if (Buffer.byteLength(text) <= maxBytes) return { text }
  let low = 0, high = text.length
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid; else high = mid - 1 }
  // Avoid a split surrogate pair at the crop boundary.
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
  return { text: text.slice(0, low), textTruncated: true }
}
export function finishSearchResult(result, maxBytes) {
  const length = () => Buffer.byteLength(JSON.stringify(result))
  if (length() > maxBytes) {
    markSearchResult(result, 'result-byte-limit')
    while (result.matches.length && length() > maxBytes) result.matches.pop()
    while (result.diagnostics.length && length() > maxBytes) result.diagnostics.pop()
    if (length() > maxBytes) { result.filters.includes = []; result.filters.excludes = []; result.filters.filterPatternsTruncated = true }
    if (result.error && length() > maxBytes) result.error = cropText(result.error, 128).text
  }
  return result
}
