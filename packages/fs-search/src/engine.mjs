import { spawn } from 'node:child_process'
import { normalizeSearchQuery, normalizeLimits, createSearchStats, createSearchResult, markSearchResult, addDiagnostic, cropText, finishSearchResult } from './options.mjs'

const encodingFlags = { auto: 'auto', utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', windows1252: 'windows-1252', latin1: 'utf-8' }
export function decodeSearchText(input, requested = 'auto') {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let encoding = requested
  if (encoding === 'auto') encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf16be' : 'utf8'
  if (!(encoding in encodingFlags)) throw new Error('unsupported encoding')
  const text = encoding === 'latin1' ? bytes.toString('latin1') : new TextDecoder({ utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', windows1252: 'windows-1252' }[encoding]).decode(bytes)
  return { text: text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), encoding }
}

function rgArgs(query, encoding) {
  const args = ['--no-config','--json','--line-buffered','--threads=1','--color=never','--regexp',query.pattern,'--encoding',encodingFlags[encoding]]
  args.push(query.mode === 'literal' ? '--fixed-strings' : '--no-fixed-strings', query.case === 'insensitive' ? '--ignore-case' : '--case-sensitive')
  if (query.regexEngine === 'pcre2') args.push('--pcre2')
  if (query.multiline) args.push('--multiline')
  if (query.before) args.push('--before-context', String(query.before))
  if (query.after) args.push('--after-context', String(query.after))
  return [...args, '--', '-']
}
const validPath = (path) => typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 256 * 1024 && !path.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path)
const byteView = (bytes) => Buffer.isBuffer(bytes) || (ArrayBuffer.isView(bytes) && Object.prototype.toString.call(bytes) === '[object Uint8Array]')
function wireBytes(value) {
  if (typeof value?.text === 'string') return Buffer.from(value.text)
  if (typeof value?.bytes === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value.bytes)) return Buffer.from(value.bytes, 'base64')
  throw new Error('invalid ripgrep text/Base64 record')
}
function position(bytes, offset, baseLine) {
  const prefix = bytes.subarray(0, offset).toString('utf8').replace(/\r\n/g, '\n')
  const pieces = prefix.split('\n')
  return { line: baseLine + pieces.length - 1, column: pieces.at(-1).length }
}

/** Search immutable admitted snapshots only. Filenames never become rg inputs. */
export async function runByteSearch({ query: input, rgPath, files, signal, limits: requestedLimits, stats = createSearchStats(), onProgress, matcher }) {
  const query = normalizeSearchQuery(input, { profile: 'human' }), limits = normalizeLimits(requestedLimits)
  const result = createSearchResult(query, stats, limits)
  const children = new Set()
  const lifetime = new AbortController()
  const iterator = files[Symbol.asyncIterator]()
  let stopped = false, iteratorClosing
  const closeIterator = () => {
    iteratorClosing ??= Promise.resolve().then(()=>iterator.return?.()).catch((error)=>{
      result.error=cropText(error.message??String(error),512).text
      addDiagnostic(result,result.error)
      markSearchResult(result,'reader-close-error',result.status==='completed'?'error':result.status)
    })
    return iteratorClosing
  }
  const stop = (reason, status = 'limited') => {
    if (stopped) return
    stopped = true
    lifetime.abort()
    markSearchResult(result, reason, status)
    for (const child of children) { try { child.kill('SIGKILL') } catch { /* closed */ } }
    void closeIterator()
  }
  const abort = () => stop('aborted', 'cancelled')
  let timer
  if (signal?.aborted) abort()
  else { signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(() => stop('timeout', 'timed-out'), query.timeoutMs) }
  const progress = (match) => {
    try { onProgress?.({ ...(match ? { match } : {}), stats: { ...stats } }) }
    catch (error) { addDiagnostic(result, error.message); result.error = cropText(error.message, 512).text; stop('consumer-error', 'error') }
  }
  function admit(chunk) {
    if (stopped) return Buffer.alloc(0)
    const remaining = Math.max(0, limits.maxEngineRawBytes - stats.engineRawBytes)
    const bytes = Buffer.from(chunk.subarray(0, remaining))
    stats.engineRawBytes += bytes.length
    return bytes
  }
  const addMatch = (row) => {
    if (stopped) return
    if (Buffer.byteLength(JSON.stringify({ ...result, matches: [...result.matches, row] })) + 1024 > query.maxResultBytes) { stop('result-byte-limit'); return }
    result.matches.push(row)
    progress(row)
    if (result.matches.length >= query.maxResults) stop('result-count-limit')
  }
  function parseMatch(entry, file, decoded) {
    if (entry.type !== 'match') return
    const data = entry.data, lines = wireBytes(data?.lines), base = data?.line_number
    if (!Number.isSafeInteger(base) || base < 1 || !Array.isArray(data.submatches)) throw new Error('invalid ripgrep match range')
    const rawText = lines.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    const text = cropText(rawText, Math.min(2048, Math.floor(query.maxResultBytes / 4)))
    const allLines = decoded.lines
    for (const sub of data.submatches) {
      if (!Number.isSafeInteger(sub.start) || !Number.isSafeInteger(sub.end) || sub.start < 0 || sub.end < sub.start || sub.end > lines.length) throw new Error('invalid ripgrep byte range')
      const start = position(lines, sub.start, base), end = position(lines, sub.end, base)
      const row = { path: file.path, line: start.line, ...text, column: start.column, endLine: end.line, endColumn: end.column, ...(file.revision ? { revision: file.revision } : {}), encoding: decoded.encoding }
      if (query.before || query.after) {
        row.context = []
        for (let line = Math.max(1, start.line - query.before); line <= Math.min(allLines.length, end.line + query.after); line++) {
          if (line >= start.line && line <= end.line) continue
          row.context.push({ line, ...cropText(allLines[line - 1], 512) })
        }
      }
      addMatch(row)
    }
  }
  async function childRun(bytes, encoding, onRecord) {
    if (stopped) return -1
    let pending = Buffer.alloc(0), stderr = Buffer.alloc(0), spawnError
    const consume = (kind, chunk) => {
      if (stopped) return
      const admitted = admit(chunk)
      if (kind === 'stderr') stderr = Buffer.concat([stderr, admitted])
      else {
        pending = Buffer.concat([pending, admitted])
        let newline
        while (!stopped && (newline = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, newline); pending = Buffer.from(pending.subarray(newline + 1))
          if (line.length) {
            try { onRecord?.(JSON.parse(line.toString('utf8'))) }
            catch (error) { addDiagnostic(result, error.message); result.error = cropText(error.message, 512).text; stop('invalid-engine-record', 'error') }
          }
        }
      }
      if (admitted.length < chunk.length || stats.engineRawBytes >= limits.maxEngineRawBytes) stop('engine-raw-limit')
    }
    if (matcher) {
      try {
        const response = await matcher({ argv: [rgPath, ...rgArgs(query, encoding)], bytes, signal: lifetime.signal, maxBytes: limits.maxEngineRawBytes - stats.engineRawBytes, onStdout(chunk) { consume('stdout', chunk); if (stopped) return 'stop' } })
        const stderrBytes = Math.min(response.stderrBytes, limits.maxEngineRawBytes - stats.engineRawBytes)
        stats.engineRawBytes += stderrBytes
        if (response.stderr) addDiagnostic(result, response.stderr)
        if (!stopped && response.stopReason) stop(response.stopReason === 'timeout' ? 'timeout' : response.stopReason === 'aborted' ? 'aborted' : response.limitReason ?? 'engine-raw-limit', response.stopReason === 'timeout' ? 'timed-out' : response.stopReason === 'aborted' ? 'cancelled' : 'limited')
        if (!stopped && pending.length) { addDiagnostic(result, 'incomplete ripgrep JSON frame'); stop('invalid-engine-record', 'error') }
        if (!stopped && response.exitCode !== 0 && response.exitCode !== 1) { result.error = cropText(response.stderr || `ripgrep failed (exit ${response.exitCode})`, 512).text; markSearchResult(result, 'engine-error', 'error') }
        return response.exitCode
      } catch (error) { result.error = cropText(`ripgrep unavailable: ${error.message}`, 512).text; addDiagnostic(result, result.error); stop('engine-unavailable', 'error'); return -1 }
    }
    let child
    try { child = spawn(rgPath, rgArgs(query, encoding), { stdio: ['pipe','pipe','pipe'], windowsHide: true }) }
    catch (error) { result.error = cropText(`ripgrep unavailable: ${error.message}`, 512).text; addDiagnostic(result, result.error); stop('engine-unavailable', 'error'); return -1 }
    children.add(child)
    child.stdout.on('data', (b) => consume('stdout', b))
    child.stderr.on('data', (b) => consume('stderr', b))
    child.on('error', (error) => { spawnError = error })
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') { spawnError = error; stop('engine-input-error', 'error') } })
    // One bounded snapshot; end() owns backpressure and there is no further write queue.
    child.stdin.end(bytes)
    const code = await new Promise((resolve) => child.once('close', (code) => resolve(code ?? -1)))
    children.delete(child)
    if (spawnError) { result.error = cropText(`ripgrep unavailable: ${spawnError.message}`, 512).text; addDiagnostic(result, result.error); if (!stopped) stop('engine-unavailable', 'error') }
    if (!stopped && pending.length) { addDiagnostic(result, 'incomplete ripgrep JSON frame'); stop('invalid-engine-record', 'error') }
    if (stderr.length) addDiagnostic(result, stderr.toString('utf8'))
    if (!stopped && code !== 0 && code !== 1) { result.error = cropText(stderr.toString('utf8') || `ripgrep failed (exit ${code})`, 512).text; markSearchResult(result, 'engine-error', 'error') }
    return code
  }
  try {
    // Same scoped rg validates regex/PCRE2/encoding even if no files are admitted.
    const validation = await childRun(Buffer.alloc(0), query.encoding)
    if (validation !== 0 && validation !== 1 && !stopped) stop('invalid-query', 'error')
    if (!stopped) await Promise.allSettled(Array.from({ length: limits.maxWorkers }, async () => {
      try {
      while (!stopped) {
        const next = await iterator.next()
        if (next.done || stopped) break
        const file = next.value
        if (!validPath(file?.path) || !byteView(file?.bytes) || file.bytes.byteLength > limits.maxFileBytes || typeof file.eof !== 'boolean') {
          addDiagnostic(result, 'invalid or oversized file snapshot'); markSearchResult(result, 'invalid-snapshot', 'error'); continue
        }
        if (!file.eof) markSearchResult(result, 'file-byte-limit')
        // Snapshot a checked view before starting an asynchronous matcher.
        const snapshot = Buffer.from(file.bytes)
        const decoded = decodeSearchText(snapshot, file.encoding ?? query.encoding)
        decoded.lines = decoded.text.split('\n')
        if (decoded.text.endsWith('\n')) decoded.lines.pop()
        const bytes = decoded.encoding === 'latin1' ? Buffer.from(decoded.text) : snapshot
        if(bytes.byteLength>2*limits.maxFileBytes) throw new Error('derived matcher stdin exceeds the bounded encoding expansion')
        const code = await childRun(bytes, file.encoding ?? query.encoding, (record) => parseMatch(record, file, decoded))
        if (code === 0 || code === 1) stats.completedFiles++
        progress()
      }
      } catch (error) {
        result.error = cropText(error.message ?? String(error), 512).text
        addDiagnostic(result, result.error)
        stop('reader-error', 'error')
      }
    }))
  } catch (error) {
    result.error = cropText(error.message ?? String(error), 512).text; addDiagnostic(result, result.error); stop('reader-error', 'error')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await closeIterator()
    // Every childRun owns close and all worker promises above are awaited.
  }
  return finishSearchResult(result, query.maxResultBytes)
}
