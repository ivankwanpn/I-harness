import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { ExecCommand, ExecResult, ExecService } from '@i-harness/exec'
import type { SearchQuery, SearchResult } from './search-types.ts'
import { runByteSearch, type MatcherRequest, type MatcherResponse, type SearchSnapshot } from './engine.mjs'
import { normalizeLimits, createSearchStats, createSearchResult, markSearchResult, addDiagnostic, finishSearchResult, type SearchLimits } from './options.mjs'

const exclusions = ['.git','.svn','.hg','.bzr','.jj','.sl','node_modules']
const portable = (path: string) => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path).replace(/^\.\//, '')
type Candidate = {path:string;absolute:string}

/** Parent only relays bounded bytes. All model filesystem access stays in the
 * no-spawn reader; every sibling uses the existing current scoped Exec. */
export async function runScopedModelSearch({ exec, rgPath, cwd, root, kind, query, signal, limits: requestedLimits }: { exec:ExecService;rgPath:string;cwd?:string;root:string;kind:'grep'|'glob';query:Required<SearchQuery>;signal?:AbortSignal;limits?:SearchLimits }): Promise<SearchResult> {
  const limits = normalizeLimits(requestedLimits), stats = createSearchStats(), initial = createSearchResult(query, stats, limits)
  initial.filters = { ...initial.filters, exclusions, explicitGlobOverridesIgnore: true, readerAuthority: 'current-scoped-exec', readerConcurrency: 4, matcherConcurrency: 1 }
  const deadline = Date.now() + query.timeoutMs, lifetime = new AbortController(), readers = new AbortController()
  const abort = () => lifetime.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; lifetime.abort() }, query.timeoutMs)
  const command = (cmd: ExecCommand, localSignal?:AbortSignal): ExecCommand => ({ ...cmd, ...(cwd !== undefined ? { cwd } : {}), timeoutMs: Math.max(1, deadline - Date.now()), abortSignal: localSignal ? AbortSignal.any([lifetime.signal, localSignal]) : lifetime.signal })
  let runnerReserved = 0, inputReserved = 0, inputCharged = 0
  const waiters = new Set<() => void>(), activeReads = new Set<Promise<unknown>>()
  const wake = () => { for (const release of waiters) release(); waiters.clear() }
  const reason = (reason: string, status?:SearchResult['status']) => markSearchResult(initial, reason, status)
  const stoppedResult = (result:ExecResult) => {
    if (result.stream?.stopReason === 'timeout') reason('timeout','timed-out')
    else if (result.stream?.stopReason === 'aborted' && lifetime.signal.aborted) reason('aborted','cancelled')
  }

  async function runShared(cmd:ExecCommand, maxEngineBytes:number, onStdout:(chunk:Buffer)=>void|'stop', localSignal?:AbortSignal): Promise<MatcherResponse> {
    const runnerRemaining = Math.max(0, limits.maxRunnerRawBytes - stats.runnerRawBytes - runnerReserved)
    const allowance = Math.min(maxEngineBytes, runnerRemaining)
    if (allowance <= 0) return { exitCode: -1, stderr:'',stderrBytes:0,stopReason:'output-limit',limitReason:runnerRemaining <= 0 ? 'runner-raw-limit':'engine-raw-limit' }
    let stdoutBytes = 0
    runnerReserved += allowance
    try {
      const ran = await exec.run(command(cmd, localSignal), { stream:{ maxBytes:allowance,onStdout(chunk) { stdoutBytes += chunk.length; stats.runnerRawBytes += chunk.length; runnerReserved -= chunk.length; return onStdout(chunk) } } })
      const stderrBytes = ran.stream?.bytesAdmitted.stderr ?? 0
      stats.runnerRawBytes += stderrBytes
      return { exitCode:ran.exitCode,stderr:ran.stderr,stderrBytes,...(ran.stream?.stopReason ? {stopReason:ran.stream.stopReason}:{}),limitReason:runnerRemaining < maxEngineBytes ? 'runner-raw-limit':'engine-raw-limit' }
    } finally { runnerReserved -= allowance - stdoutBytes; wake() }
  }

  async function enumerate(): Promise<Candidate[]> {
    const argv = [rgPath,'--no-config','--files','--null','--threads=1']
    if (query.hidden) argv.push('--hidden')
    if (!query.respectIgnore) argv.push('--no-ignore')
    if (kind === 'glob') argv.push(`--glob=${query.pattern}`)
    for (const p of query.includes) argv.push(`--glob=${p}`)
    for (const p of query.excludes) argv.push(`--glob=!${p}`)
    if (!(kind === 'grep' && portable(root).split('/').some((p) => exclusions.includes(p.toLowerCase())))) for (const p of exclusions) argv.push(`--glob=!**/${p}`,`--glob=!**/${p}/**`)
    argv.push('--',root)
    const candidates:Candidate[] = []
    let pending = Buffer.alloc(0), pathBytes = 0, consumerStopped = false
    const rootAbsolute = resolve(cwd ?? process.cwd(),root)
    const ran = await runShared({ argv }, limits.maxEngineRawBytes - stats.engineRawBytes, (chunk) => {
      stats.engineRawBytes += chunk.length
      const admitted=chunk.subarray(0,Math.max(0,256*1024-pending.length))
      pending = Buffer.concat([pending,admitted])
      let nul
      while ((nul = pending.indexOf(0)) !== -1) {
        const frame = pending.subarray(0,nul); pending = Buffer.from(pending.subarray(nul+1))
        let name:string
        try { name = new TextDecoder('utf-8',{fatal:true}).decode(frame) }
        catch { reason('invalid-path','error'); addDiagnostic(initial,'invalid UTF8 candidate path'); continue }
        pathBytes += frame.length
        if (pathBytes > 256 * 1024) { reason('candidate-frame-limit'); consumerStopped = true; return 'stop' }
        const absolute = resolve(cwd ?? process.cwd(),name), belowRoot = portable(relative(rootAbsolute,absolute))
        if (!name) { reason('invalid-path','error'); continue }
        if (!query.hidden && belowRoot && belowRoot.split('/').some((part) => part.startsWith('.'))) continue
        const path = kind === 'glob' ? belowRoot || portable(name) : portable(name)
        candidates.push({path,absolute}); stats.candidateFiles++
        if (kind === 'glob') {
          if (Buffer.byteLength(JSON.stringify({...initial,matches:[...initial.matches,path]}))+1024 > query.maxResultBytes) { reason('result-byte-limit'); consumerStopped = true; return 'stop' }
          ;(initial.matches as unknown[]).push(path)
          if (initial.matches.length >= query.maxResults) { reason('result-count-limit'); consumerStopped = true; return 'stop' }
        }
        if (stats.candidateFiles >= limits.maxCandidates) { reason('candidate-limit'); consumerStopped = true; return 'stop' }
      }
      if(admitted.length<chunk.length) { reason('candidate-frame-limit');consumerStopped=true;return 'stop' }
    })
    stats.engineRawBytes += ran.stderrBytes
    if (ran.stderr) addDiagnostic(initial,ran.stderr)
    if (ran.stopReason === 'output-limit') reason(ran.limitReason ?? 'engine-raw-limit')
    else if (ran.stopReason === 'aborted') reason('aborted','cancelled')
    else if (ran.stopReason === 'timeout') reason('timeout','timed-out')
    else if (!consumerStopped && ran.exitCode !== 0 && ran.exitCode !== 1) { initial.error = ran.stderr.slice(0,512) || `ripgrep enumeration failed (exit ${ran.exitCode})`; reason('enumeration-error','error') }
    if (!consumerStopped && !ran.stopReason && pending.length) { reason('candidate-frame-error','error'); addDiagnostic(initial,'incomplete NUL candidate frame') }
    return candidates
  }

  async function read(candidate:Candidate, allowance:number): Promise<SearchSnapshot | undefined> {
    const metadataAllowance = 2048
    let received = 0, actual = allowance
    const chunks:Buffer[] = []
    runnerReserved += metadataAllowance
    inputReserved += allowance
    try {
      const input = JSON.stringify({path:candidate.absolute,maxBytes:allowance})
      if (Buffer.byteLength(input)>64*1024) throw new Error('reader control exceeds 64 KiB')
      const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      const ran = await exec.run(command({argv:[process.execPath,fileURLToPath(new URL('./reader.mjs',import.meta.url))],input,env:{...inherited,ELECTRON_RUN_AS_NODE:'1'}},readers.signal), {stream:{maxBytes:allowance+metadataAllowance,onStdout(chunk) {
        const count = Math.min(chunk.length,allowance-received)
        if (count) { chunks.push(Buffer.from(chunk.subarray(0,count))); received+=count }
        if (count<chunk.length) return 'stop'
      }}})
      const controlBytes=ran.stream?.bytesAdmitted.stderr ?? 0
      stats.runnerRawBytes += Math.min(metadataAllowance,controlBytes)
      if(controlBytes>metadataAllowance) { reason('reader-control-limit'); readers.abort() }
      stoppedResult(ran)
      let metadata:{attempted?:boolean;read?:boolean;eof?:boolean;inputBytes?:number;error?:string}|undefined
      let started = false
      for (const line of Buffer.from(ran.stderr).subarray(0,metadataAllowance).toString('utf8').split('\n')) {
        try { const m = JSON.parse(line); if (m.type==='start') started=m.attempted===true; if(m.type==='read') metadata=m } catch { /* Provider diagnostics remain bounded stderr. */ }
      }
      if (started || metadata?.attempted) stats.attemptedFiles++
      if (metadata?.read || received) stats.readFiles++
      const valid = metadata && Number.isSafeInteger(metadata.inputBytes) && metadata.inputBytes!>=received && metadata.inputBytes!<=allowance
      actual = valid ? metadata!.inputBytes! : allowance
      stats.inputBytes += valid ? actual : received
      const eof = valid && metadata!.eof===true && metadata!.inputBytes===received && !metadata!.error && !ran.stream?.stopReason
      if (eof) stats.eofFiles++
      if (!valid) { initial.filters.statisticsCoverage='last-reported'; if (!lifetime.signal.aborted && !readers.signal.aborted) { reason('reader-error','error'); addDiagnostic(initial,ran.stderr || 'reader ended without metadata') } }
      if (metadata?.error) { reason('file-read-error','error'); addDiagnostic(initial,`${candidate.path}: ${metadata.error}`) }
      if(!metadata?.read && !received) return
      if (!eof && !lifetime.signal.aborted && !readers.signal.aborted) reason(actual>=limits.maxFileBytes ? 'file-byte-limit':'input-byte-limit')
      if (lifetime.signal.aborted || readers.signal.aborted) return
      const bytes = Buffer.concat(chunks,received)
      return {path:candidate.path,bytes,eof:Boolean(eof),revision:createHash('sha256').update(bytes).digest('hex')}
    } finally { inputReserved-=allowance; inputCharged+=actual; runnerReserved-=metadataAllowance; wake() }
  }

  let index = 0, names:Promise<Candidate[]>|undefined, readerClosed = false
  const files:AsyncIterableIterator<SearchSnapshot> = {
    async next() {
      names ??= enumerate()
      const candidates = await names
      while (!readerClosed && !lifetime.signal.aborted && index<candidates.length) {
        if (stats.engineRawBytes>=limits.maxEngineRawBytes || stats.runnerRawBytes+runnerReserved>=limits.maxRunnerRawBytes) return {done:true,value:undefined}
        const available = limits.maxInputBytes-inputCharged-inputReserved
        if (available<=0 && inputReserved>0) { await new Promise<void>((r)=>waiters.add(r)); continue }
        if (available<=0) { reason('input-byte-limit'); return {done:true,value:undefined} }
        if (limits.maxRunnerRawBytes-stats.runnerRawBytes-runnerReserved<2048) { reason('runner-raw-limit'); return {done:true,value:undefined} }
        const pending = read(candidates[index++]!,Math.min(limits.maxFileBytes,available))
        activeReads.add(pending)
        let value:SearchSnapshot|undefined
        try { value=await pending } finally { activeReads.delete(pending) }
        if(value) return {done:false,value}
      }
      return {done:true,value:undefined}
    },
    async return() { readerClosed=true; readers.abort(); wake(); await Promise.allSettled([...activeReads]); return {done:true,value:undefined} },
    [Symbol.asyncIterator]() {return this},
  }
  let matchTail:Promise<void> = Promise.resolve()
  const matcher = async (request:MatcherRequest):Promise<MatcherResponse> => {
    const previous=matchTail
    let release!:()=>void
    matchTail=new Promise<void>((r)=>{release=r})
    await previous
    try {
      if(request.signal.aborted || lifetime.signal.aborted) return {exitCode:-1,stderr:'',stderrBytes:0,stopReason:'aborted'}
      return await runShared({argv:request.argv,inputBytes:request.bytes},request.maxBytes,request.onStdout,request.signal)
    } finally {release()}
  }
  let result=initial
  try {
    if(lifetime.signal.aborted) reason('aborted','cancelled')
    else if(kind==='glob') await enumerate()
    else {
      result=await runByteSearch({query,rgPath,files,signal:lifetime.signal,limits,stats,matcher})
      for(const reason of initial.reasons) markSearchResult(result,reason,initial.status)
      for(const diagnostic of initial.diagnostics) addDiagnostic(result,diagnostic)
      if(initial.error) result.error=initial.error
      result.filters=initial.filters
    }
    if(lifetime.signal.aborted) markSearchResult(result,timedOut?'timeout':'aborted',timedOut?'timed-out':'cancelled')
  } catch(error) { result.error=String(error instanceof Error?error.message:error).slice(0,512); addDiagnostic(result,result.error); markSearchResult(result,'runner-error','error') }
  finally { await files.return?.(); await matchTail; clearTimeout(timer); signal?.removeEventListener('abort',abort) }
  return finishSearchResult(result,query.maxResultBytes)
}
