import { expect, it, vi } from 'vitest'
// Legacy discovery walks ancestors; this fixture has no instruction files.
// Guard the actual filesystem candidate operation before any user-home read.
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, existsSync: (path: import('node:fs').PathLike) => /(?:^|[\\/])(?:AGENTS|CLAUDE)\.md$/i.test(String(path)) ? false : fs.existsSync(path) }
})
const preparations = vi.hoisted(() => [] as any[])
vi.mock('../../compaction/src/prepared-summary.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../compaction/src/prepared-summary.ts')>()
  return { ...actual, prepareSummary: async (...args: Parameters<typeof actual.prepareSummary>) => {
    const result = await actual.prepareSummary(...args)
    const directive = String(args[1].messages.at(-1)?.content)
    const manifest = JSON.parse(directive.match(/<recorded-source-manifest>(.*?)<\/recorded-source-manifest>/s)![1]!)
    preparations.push({ ...result.facts, inputBytes: result.candidate.measurement.packet.bodyBytes, inputFingerprint: result.candidate.measurement.input.inputFingerprint, disposition: result.decision.disposition, pressure: result.decision.pressure, mode: manifest.mode ?? 'full', sourceBytes: manifest.fragments?.reduce((n: number, range: any) => n + range.endByte - range.startByte, 0), pageDigest: manifest.pageDigest })
    return result
  } }
})
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import type { SessionEvent } from '@i-harness/core-session'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { describeContext } from '../../llm-openai-compatible/src/context.ts'
import { createDesktopHost } from '../src/host.ts'

const objective = 'TASK-60: Read page-0.txt through page-59.txt exactly once; preserve the completed reads and finish with TASK-60-COMPLETE.'
const followup = 'COLD-FOLLOWUP: Read followup.txt exactly once and finish with COLD-FOLLOWUP-COMPLETE.'
const page = '合成資料保留完整工具結果'.repeat(450) + '\nexport function sample(value: number) { return value + 1 }\n'.repeat(10)
const fact = (index: number) => `事實${String(index).padStart(2, '0').replace(/\d/g, digit => String.fromCharCode(0xff10 + Number(digit)))}值${String(index * 17 + 31).padStart(3, '0').replace(/\d/g, digit => String.fromCharCode(0xff10 + Number(digit)))}`
const factsIn = (text: string) => [...new Set(text.match(/事實[０-９]{2}值[０-９]{3}/g) ?? [])].sort()
const markedPage = (index: number) => page.slice(0, 2900) + fact(index) + page.slice(2900 + fact(index).length)

/** Independent receiver oracle: use only decoded wire messages, never IH projection helpers. */
function pairing(messages: any[]) {
  const errors: string[] = [], pending = new Set<string>(), calls = new Set<string>(), results = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) errors.push(`orphan/duplicate result ${message.tool_call_id} at ${index}`)
      results.add(message.tool_call_id)
    } else {
      if (pending.size) errors.push(`interleaved ${message.role} at ${index}: ${[...pending]}`)
      for (const call of message.tool_calls ?? []) {
        if (calls.has(call.id)) errors.push(`duplicate call ${call.id}`)
        calls.add(call.id); pending.add(call.id)
      }
    }
  }
  if (pending.size) errors.push(`missing results: ${[...pending]}`)
  const text = JSON.stringify(messages), recordedCalls = [...text.matchAll(/\[recorded tool call \w+ id=([^\]]+)\]/g)].map(match => match[1]!),
    recordedResults = [...text.matchAll(/\[recorded tool result ([^\]]+)\]/g)].map(match => match[1]!)
  if (recordedCalls.join() !== recordedResults.join()) errors.push('portable recorded source call/result mismatch')
  return { errors, calls: [...calls], results: [...results], recordedCalls, recordedResults }
}

function completed(messages: any[]) {
  const done = new Set<number>()
  for (const message of messages) {
    if (message.role === 'tool' && /^read-\d+$/.test(message.tool_call_id)) done.add(Number(message.tool_call_id.slice(5)))
    for (const match of JSON.stringify(message.content ?? '').matchAll(/COMPLETED\[([\d,]*)\]/g)) {
      for (const number of match[1]!.split(',').filter(Boolean)) done.add(Number(number))
    }
    for (const match of JSON.stringify(message.content ?? '').matchAll(/\[recorded tool result read-(\d+)\]/g)) done.add(Number(match[1]))
    if (Array.isArray(message.content)) for (const part of message.content) {
      try { const data = JSON.parse(part.text); if (data.source?.callId?.startsWith('read-') && data.source.field === 'tool-text' && data.fragment.endByte === data.fragment.totalBytes) done.add(Number(data.source.callId.slice(5))) } catch { /* ordinary text */ }
    }
  }
  return [...done].sort((a, b) => a - b)
}

async function probe(mode: 'repeated60' | 'parallel24', middleFacts = false) {
  preparations.length = 0
  const initialObjective = objective + (middleFacts ? ' Return every exact middle fact from all 24 source files in the final answer and retain them for follow-up.' : '')
  const root = await mkdtemp(join(tmpdir(), 'ih-lg-')), workspace = join(root, 'w')
  await mkdir(workspace)
  const count = mode === 'repeated60' ? 60 : 24
  for (let i = 0; i < count; i++) await writeFile(join(workspace, `page-${i}.txt`), middleFacts ? markedPage(i) : page)
  await writeFile(join(workspace, 'followup.txt'), 'Synthetic cold follow-up original.')
  const frames: RpcMessage[] = [], wire: any[] = [], rawRequests: string[] = []
  const observedSegments: { id: string; offset: number; text: string }[] = []
  let sourceDigest: string | undefined, originalCoverage: unknown, groupManifest: string | undefined
  let segmentIndex = 0
  const expectedTexts = ['推理保留'.repeat(250), 'Reading the next synthetic source.',
    ...Array.from({ length: count }, (_, i) => JSON.stringify({ path: `page-${i}.txt` })),
    ...Array.from({ length: count }, (_, i) => JSON.stringify({ content: middleFacts ? markedPage(i) : page }))]
  const acceptWirePage = (messages: any[]) => {
    const directive = messages.at(-1).content
    const manifest = JSON.parse(directive.match(/<recorded-source-manifest>(.*?)<\/recorded-source-manifest>/s)[1])
    if (manifest.mode !== 'recorded-pages-v1') return
    sourceDigest ??= manifest.sourceDigest; expect(manifest.sourceDigest).toBe(sourceDigest)
    groupManifest ??= JSON.stringify(manifest.groups.map((group: any) => ({ group: group.group, sources: group.sources })))
    expect(JSON.stringify(manifest.groups.map((group: any) => ({ group: group.group, sources: group.sources })))).toBe(groupManifest)
    originalCoverage ??= manifest.groups.flatMap((group: any) => group.sources)
    // The wire adapter adds system messages; manifest positions refer to neutral messages.
    const neutral = messages.filter(message => message.role !== 'system')
    expect(neutral.slice(0, -1).every(message => message.role === 'user')).toBe(true)
    for (const range of manifest.fragments) {
      const data = JSON.parse(neutral[range.message].content[range.part].text)
      expect(data.fragment).toEqual(Object.fromEntries(Object.entries(range).filter(([key]) => key !== 'message' && key !== 'part')))
      const expected = expectedTexts[segmentIndex]!, expectedBytes = Buffer.from(expected)
      const entry = observedSegments[segmentIndex] ?? (observedSegments[segmentIndex] = { id: range.segmentId, offset: 0, text: '' })
      expect(range.segmentId).toBe(entry.id); expect(range.startByte).toBe(entry.offset)
      expect(range.totalBytes).toBe(expectedBytes.length); expect(range.digest).toBe(createHash('sha256').update(expectedBytes).digest('hex'))
      const fragment = Buffer.from(data.text)
      expect(fragment.length).toBe(range.endByte - range.startByte)
      expect(fragment.equals(expectedBytes.subarray(range.startByte, range.endByte))).toBe(true)
      expect(fragment.toString('utf8')).toBe(data.text)
      if (segmentIndex >= 2) { const i = (segmentIndex - 2) % count; expect(data.source.callId).toBe(`read-${i}`); expect(data.source.callName).toBe('read'); expect(data.source.field).toBe(segmentIndex < count + 2 ? 'call-arguments' : 'tool-text') }
      entry.offset = range.endByte; entry.text += data.text
      if (entry.offset === range.totalBytes) { expect(entry.text).toBe(expected); segmentIndex++ }
    }
  }
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  let events: SessionEvent[] = [], sessionId = '', rpcId = 0, phase = 'initial', outcome: unknown, watchdog = false
  const started = new Date().toISOString()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks), raw = bytes.toString('utf8'), body = JSON.parse(raw)
        rawRequests.push(raw)
        const summary = JSON.stringify(body.messages?.at(-1)).includes('You are now acting as a compaction engine')
        const kind = summary ? 'summary' : body.tools?.length ? 'main' : 'title'
        const pairs = pairing(body.messages ?? []), done = completed(body.messages ?? [])
        // Synthetic usage deliberately follows IH's heuristic. This is NOT an independent tokenizer.
        const input = describeContext(body, { model: 'fixture', apiKey: 'controlled' }).input
        const heuristic = Object.values(input.components).reduce((sum, component) => sum + component.heuristicTokens, 0)
        const record = { index: wire.length, utc: new Date().toISOString(), phase, kind, route: req.url,
          bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), messages: body.messages.length,
          systemBytes: Buffer.byteLength(JSON.stringify(body.messages.filter((m: any) => m.role === 'system'))),
          schemaBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])),
          reasoningBytes: Buffer.byteLength(JSON.stringify(body.messages.map((m: any) => m.reasoning_content ?? ''))),
          heuristic, cap: body.max_tokens, pairs, completed: done, objectiveVisible: raw.includes('TASK-60'), status: 200 }
        wire.push(record)
        if (wire.length > 150 || rawRequests.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0) > 64 * 1024 * 1024) throw Error('bounded receiver limit exceeded')
        if (pairs.errors.length) throw Error(`receiver pairing rejected: ${pairs.errors.join('; ')}`)
        let delta: any
        if (kind === 'title') delta = { content: 'Synthetic repeated growth' }
        else if (summary) {
          if (mode === 'parallel24') acceptWirePage(body.messages)
          // The current instruction stays protected outside this selected summary source.
          const retained = `Recorded completed work. COMPLETED[${done.join(',')}] ${factsIn(JSON.stringify(body.messages)).join(' ')}`
          delta = { content: checkpointOfLength(Math.max(900, retained.length + 400), retained) }
        } else if (phase === 'cold') {
          if (!raw.includes('COLD-FOLLOWUP')) throw Error('cold follow-up instruction missing')
          delta = pairs.results.includes('cold-read') ? { content: `COLD-FOLLOWUP-COMPLETE ${factsIn(raw).join(' ')}` }
            : { tool_calls: [{ index: 0, id: 'cold-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'followup.txt' }) } }] }
        } else {
          if (!raw.includes(initialObjective)) throw Error('main lost current task instruction')
          const remaining = Array.from({ length: count }, (_, i) => i).filter(i => !done.includes(i))
          const selected = mode === 'parallel24' ? remaining : remaining.slice(0, 1)
          if (mode === 'parallel24' && !selected.length) expect(segmentIndex).toBe(expectedTexts.length)
          delta = selected.length ? { content: 'Reading the next synthetic source.', reasoning_content: '推理保留'.repeat(250),
            tool_calls: selected.map((i, index) => ({ index, id: `read-${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `page-${i}.txt` }) } })) }
            : { content: `TASK-60-COMPLETE ${factsIn(raw).join(' ')}` }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: heuristic, prompt_cache_hit_tokens: Math.max(0, heuristic - 162), completion_tokens: 1100 } })}\n\ndata: [DONE]\n\n`)
      } catch (error) {
        if (wire.length) { wire.at(-1).status = 400; wire.at(-1).error = String(error) }
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing endpoint')
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json'), sessionDir = join(root, 's')
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: 'read-only', webSearchMode: 'disabled', compaction: { auto: true },
    llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: 'IH_LONG_GROWTH_DIAG_KEY', models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 20000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_LONG_GROWTH_DIAG_KEY: 'controlled' } }))
  const open = async () => { host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => frames.push(frame) }) }
  const rpc = async (method: string, params: unknown) => {
    const id = ++rpcId
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([host!.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params })), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { watchdog = true; reject(Error(`watchdog: ${method}; wire=${wire.length}; phase=${phase}`)) }, 180000)
      })])
    } finally { clearTimeout(timer) }
    const response = frames.find(frame => 'id' in frame && frame.id === id)
    if (!isRpcSuccess(response)) throw Error(response && 'error' in response ? JSON.stringify({ code: response.error.code, message: response.error.message }) : 'missing RPC response')
    return response.result as any
  }
  const history = async (): Promise<SessionEvent[]> => {
    const all: SessionEvent[] = []
    let afterSeq = 0
    for (let page = 0; page < 10; page++) {
      const result = await rpc('session/history', { sessionId, afterSeq, limit: 1000 })
      all.push(...result.events)
      if (result.events.length < 1000) return all
      if (result.nextSeq <= afterSeq) throw Error('history cursor made no progress')
      afterSeq = result.nextSeq
    }
    throw Error('bounded history page limit exceeded')
  }
  try {
    expect(page.length).toBeLessThan(8192); expect(Buffer.byteLength(page)).toBeLessThan(64000)
    if (middleFacts) for (let i = 0; i < count; i++) { expect(markedPage(i).length).toBe(page.length); expect(Buffer.byteLength(markedPage(i))).toBe(Buffer.byteLength(page)); expect(markedPage(i).slice(0, 512) + markedPage(i).slice(-512)).not.toContain(fact(i)) }
    await open(); await rpc('initialize', {}); ({ sessionId } = await rpc('session/create', {}))
    let promptError: unknown
    try { await rpc('session/prompt', { sessionId, prompt: initialObjective }) } catch (error) { promptError = String(error) }
    events = await history()
    const dispatch = events.filter(event => event.type === 'tool/dispatch').map(event => event.callId)
    const results = events.filter(event => event.type === 'tool/result')
    const replacements = events.filter(event => event.type === 'compaction/replacement')
    outcome = { promptError, dispatch, results: results.length, replacements: replacements.length }
    expect(new Set(dispatch).size).toBe(count); expect(dispatch).toHaveLength(count)
    expect([...dispatch].sort()).toEqual(Array.from({ length: count }, (_, i) => `read-${i}`).sort())
    expect(results).toHaveLength(count)
    const originals = results.map(event => event.envelope?.retention.kind === 'inline' ? event.envelope.retention.value : event.output)
    expect(results.every(event => event.envelope?.execution.outcome === 'succeeded')).toBe(true)
    expect(originals.every((output, index) => JSON.stringify(output).includes(JSON.stringify(middleFacts ? markedPage(Number(results[index]!.callId.slice(5))) : page).slice(1, -1)))).toBe(true)
    expect(originals.every(output => JSON.stringify(output).length < 8192)).toBe(true)
    expect(events.some(event => event.type === 'compaction/prune' || event.type === 'context/result-ref')).toBe(false)
    expect(wire.every(request => request.status === 200 && !request.pairs.errors.length)).toBe(true)
    expect(promptError).toBeUndefined()
    expect(replacements.length).toBeGreaterThanOrEqual(mode === 'parallel24' ? 1 : 3)
    if (mode === 'parallel24') expect(replacements[0]!.coverage).toEqual(originalCoverage)
    if (middleFacts) { expect(factsIn(JSON.stringify(replacements.at(-1)))).toEqual(Array.from({ length: count }, (_, index) => fact(index))); expect(factsIn(JSON.stringify(events.filter(event => event.type === 'assistant/message').at(-1)))).toEqual(Array.from({ length: count }, (_, index) => fact(index))) }
    expect(events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('TASK-60-COMPLETE'))).toBe(true)
    const main = wire.filter(request => request.kind === 'main')
    expect(main).toHaveLength(mode === 'parallel24' ? 2 : 61)
    const drops = main.slice(1).map((request, index) => ({ before: main[index], after: request })).filter(pair => pair.after.bytes < pair.before.bytes)
    if (mode === 'repeated60') expect(drops.length).toBeGreaterThanOrEqual(3)
    expect(drops.every(pair => wire.slice(pair.before.index + 1, pair.after.index).some(request => request.kind === 'summary'))).toBe(true)
    if (mode === 'repeated60') expect(drops.filter(pair => main.some(request => request.index > pair.after.index && request.bytes > pair.after.bytes)).length).toBeGreaterThanOrEqual(3)
    await host!.close(); host = undefined; phase = 'cold'
    await open(); await rpc('initialize', {})
    const restored = await history()
    expect(restored.filter((event: SessionEvent) => event.type === 'tool/result')).toEqual(results)
    await rpc('session/prompt', { sessionId, prompt: followup })
    events = await history()
    expect(events.filter(event => event.type === 'tool/dispatch' && event.callId === 'cold-read')).toHaveLength(1)
    expect(events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('COLD-FOLLOWUP-COMPLETE'))).toBe(true)
    expect(wire.filter(request => request.phase === 'cold' && request.kind === 'main')).toHaveLength(2)
    expect(wire.filter(request => request.phase === 'cold' && request.kind === 'main').every(request => request.completed.length === count)).toBe(true)
    expect(events.filter(event => event.type === 'tool/dispatch' && event.callId !== 'cold-read')).toHaveLength(count)
    if (middleFacts) expect(factsIn(JSON.stringify(events.filter(event => event.type === 'assistant/message').at(-1)))).toEqual(Array.from({ length: count }, (_, index) => fact(index)))
    if (mode === 'parallel24') expect(wire.filter(request => request.kind === 'summary').length).toBeLessThanOrEqual(8)
    if (mode === 'parallel24') { expect(observedSegments.map(segment => segment.text)).toEqual(expectedTexts); expect(preparations.filter(p => p.mode === 'recorded-pages-v1' && p.disposition === 'reduce').length).toBeLessThanOrEqual(2) }
    outcome = { ...outcome as object, coldFollowup: 'complete', bodyDrops: drops.map(pair => ({ before: pair.before.index, after: pair.after.index, beforeBytes: pair.before.bytes, afterBytes: pair.after.bytes })) }
    const heuristicOverWindow = wire.filter(request => request.kind !== 'title' && request.heuristic + request.cap + (request.kind === 'summary' ? 5000 : 10000) > 100000)
    outcome = { ...outcome as object, heuristicOverWindow: heuristicOverWindow.map(request => ({ index: request.index, kind: request.kind, heuristic: request.heuristic, cap: request.cap })) }
    expect(heuristicOverWindow).toEqual([])
  } catch (error) {
    outcome = { ...outcome as object, assertionFailure: String(error) }; throw error
  } finally {
    if (process.env.IH_LONG_GROWTH_EVIDENCE_DIR) {
      const evidence = resolve(process.env.IH_LONG_GROWTH_EVIDENCE_DIR, middleFacts ? 'middle24' : mode)
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, 'receiver.json'), JSON.stringify({ started, finished: new Date().toISOString(), mode, root, phase, watchdog, pageChars: page.length, pageBytes: Buffer.byteLength(page), outcome, preparations, coverage: observedSegments.map(segment => ({ id: segment.id, bytes: segment.offset, digest: createHash('sha256').update(segment.text).digest('hex') })), wire }, null, 2))
      await writeFile(join(evidence, 'wire.jsonl.gz'), gzipSync(rawRequests.join('\n')))
      await writeFile(join(evidence, 'events.json'), JSON.stringify(events, null, 2))
      await writeFile(join(evidence, 'frames.json'), JSON.stringify(frames, null, 2))
    }
    await host?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    // root is a fresh short mkdtemp child owned solely by this probe.
    if (!resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw Error('unexpected probe cleanup path')
    await rm(root, { recursive: true, force: true })
  }
}

it('continues sixty actual file reads through three committed compactions and a cold follow-up', () => probe('repeated60'), 210000)
it('completes the original parallel24 shape and a cold follow-up', () => probe('parallel24'), 30000)
it('preserves all middle facts through the same parallel24 shape and cold follow-up', () => probe('parallel24', true), 30000)
