import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOOTSTRAP, WSL_EXE } from '../src/transport.ts'

type Representation = { format: 'buffer'; base64: string } | { format: 'string'; text: string; encoding: string | null }
type Entry = { child?: ChildProcess; closed: boolean; eof: Set<string>; errors: unknown[]; bytes: Record<string, Buffer[]>; representations: Record<string, Representation[]>; role: string; meta: unknown; closeCode?: number | null; signal?: string | null; producerFailed?: boolean; controlClosed?: boolean; acquiredAt?: number; pid?: number; timer?: ReturnType<typeof setTimeout> }
const WARNING = Buffer.from('wsl: 偵測到 localhost Proxy 設定，但未鏡像到 WSL。NAT 模式中的 WSL 不支援 localhost Proxy。\r\n', 'utf16le')
export function recordedDiagnostic(entry: Entry) {
  const chunks = entry.representations.stderr
  if (!chunks.length) return { classification: 'empty', format: 'empty', nativeByteExact: true, text: '' }
  const meta = entry.meta as { executable?: string; args?: unknown[] }
  const args = meta.args ?? []
  const worker = entry.role === 'worker' && JSON.stringify(args) === JSON.stringify(['--distribution', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', '/usr/bin/python3', '-I', '-B', '-u', '-c', BOOTSTRAP])
  const helper = entry.role === 'helper' && args.length === 9 && JSON.stringify(args.slice(0, 8)) === JSON.stringify(['--distribution', 'Ubuntu', '--exec', '/usr/bin/python3', '-I', '-B', '-c', IDENTITY_HELPER]) && typeof args[8] === 'string'
  if (meta.executable !== WSL_EXE || entry.child?.spawnfile !== WSL_EXE || JSON.stringify(entry.child.spawnargs) !== JSON.stringify([WSL_EXE, ...args]) || (!worker && !helper)) throw new Error('diagnostic from unrecognized original launcher/command')
  if (chunks.every(chunk => chunk.format === 'buffer')) {
    const native = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.base64, 'base64')))
    if (!native.equals(WARNING)) throw new Error('unknown/extra/altered diagnostic bytes')
    return { classification: 'recorded-localhost-proxy-nat-warning', format: 'native-buffer', nativeByteExact: true, base64: native.toString('base64'), text: native.toString('utf16le') }
  }
  if (helper && chunks.every(chunk => chunk.format === 'string' && chunk.encoding === 'utf8')) {
    const text = chunks.map(chunk => chunk.format === 'string' ? chunk.text : '').join('')
    if (text !== WARNING.toString('utf8')) throw new Error('unknown/extra/altered decoded diagnostic')
    return { classification: 'recorded-localhost-proxy-nat-warning', format: 'decoded-string:utf8', nativeByteExact: false, text }
  }
  throw new Error('unknown diagnostic representation')
}
export class ControllerGuard {
  readonly entries: Entry[] = []
  readonly failures: unknown[] = []
  readonly operations: { label: string; state: string; error?: string }[] = []
  readonly audits: { label: string; ok: boolean; error?: string }[] = []
  private failed!: (error: Error) => void
  private readonly failure = new Promise<never>((_resolve, reject) => { this.failed = reject })
  constructor(readonly deadlineMs = 90_000) { void this.failure.catch(() => {}) }
  fail(error: unknown): void {
    this.failures.push(error)
    this.failed(error instanceof Error ? error : new Error(String(error)))
  }
  acquire(role: string, producer: () => ChildProcess, meta: unknown): ChildProcess {
    const entry: Entry = { role, meta, closed: false, eof: new Set(), errors: [], bytes: { stdout: [], stderr: [] }, representations: { stdout: [], stderr: [] } }
    this.entries.push(entry) // Reservation precedes native producer.
    let child: ChildProcess
    try { child = producer() } catch (error) { entry.producerFailed = true; entry.errors.push(error); this.fail(error); throw error }
    if (this.entries.some(other => other !== entry && other.child === child)) {
      this.entries.splice(this.entries.indexOf(entry), 1)
      return child
    }
    entry.child = child // Identical capability is retained before any fallible observation.
    try {
      entry.pid = child.pid; entry.acquiredAt = performance.now()
      entry.timer = setTimeout(() => { this.fail(new Error('original child deadline; cleanup unconfirmed')); this.closeControls() }, this.deadlineMs)
      child.on('error', error => { entry.errors.push(error); this.fail(error) })
      child.on('close', (code, signal) => { entry.closed = true; entry.closeCode = code; entry.signal = signal; clearTimeout(entry.timer) })
      for (const name of ['stdout', 'stderr'] as const) {
        const stream = child[name]
        if (!stream) throw new Error('missing original pipe')
        let size = 0
        stream.on('data', (data: Buffer | string) => {
          try {
            const bytes = Buffer.from(data); size += bytes.length
            if (size > 2 * 1024 * 1024) throw new Error('raw evidence cap exceeded')
            entry.representations[name].push(Buffer.isBuffer(data) ? { format: 'buffer', base64: data.toString('base64') }
              : { format: 'string', text: data, encoding: stream.readableEncoding })
            // Derived UTF-8 projections remain convenient for frame inspection;
            // representations, never this array, define native-byte evidence.
            entry.bytes[name].push(bytes)
          } catch (error) { entry.errors.push(error); this.fail(error); this.closeControls() }
        })
        stream.on('end', () => entry.eof.add(name))
        stream.on('error', error => { entry.errors.push(error); this.fail(error) })
      }
      child.stdin?.on('error', error => { entry.errors.push(error); this.fail(error) })
    } catch (error) { entry.errors.push(error); this.fail(error); this.closeControls() }
    return child // Never lose an acquired child behind an observer exception.
  }
  closeControls(): void {
    for (const entry of this.entries) {
      if (entry.role !== 'worker' || !entry.child || entry.closed || entry.controlClosed) continue
      entry.controlClosed = true // One attempt, even if end/destroy throws.
      try { entry.child.stdin?.end() } catch (error) { entry.errors.push(error); this.fail(error) }
      try { entry.child.stdin?.destroy() } catch (error) { entry.errors.push(error); this.fail(error) }
    }
  }
  track<T>(label: string, promise: Promise<T>, raceFailure = true): Promise<T> {
    const operation = { label, state: 'pending', error: undefined as string | undefined }
    this.operations.push(operation)
    const observed = promise.then(value => { operation.state = 'fulfilled'; return value }, error => { operation.state = 'rejected'; operation.error = String(error); throw error })
    void observed.catch(() => {})
    return raceFailure ? Promise.race([observed, this.failure]) : observed
  }
  async cleanup<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.track(label, promise, false), new Promise<never>((_yes, no) => {
        timer = setTimeout(() => { const error = new Error('cleanup deadline; original operation retained'); this.fail(error); this.closeControls(); no(error) }, ms)
      })])
    } finally { clearTimeout(timer) }
  }
  async join(ms = 4000): Promise<void> {
    const limit = Date.now() + ms
    while (this.entries.some(entry => !entry.producerFailed && (!entry.closed || entry.eof.size !== 2))
      || this.operations.some(operation => operation.state === 'pending')) {
      if (Date.now() >= limit) { this.fail(new Error('original children/stdio/operations unresolved')); throw new Error('cleanup UNKNOWN') }
      await new Promise(resolve => setTimeout(resolve, 10)) // Test-only bounded cleanup join, not product event implementation.
    }
  }
  audit(): void {
    if (this.failures.length || this.entries.some(entry => entry.producerFailed || !entry.closed || entry.closeCode !== 0
      || entry.signal || entry.child?.killed || entry.eof.size !== 2 || entry.errors.length)
      || this.operations.some(operation => operation.state === 'pending')) throw new AggregateError(this.failures, 'original ownership incomplete/failed')
  }
  runAudits(checks: readonly (readonly [string, () => void])[]): unknown[] {
    const failures: unknown[] = []
    for (const [label, action] of checks) {
      try { action(); this.audits.push({ label, ok: true }) }
      catch (error) { failures.push(error); this.fail(error); this.audits.push({ label, ok: false, error: String(error) }) }
    }
    return failures
  }
  save(path: string): void {
    try {
      this.entries.forEach((entry, index) => {
        for (const name of ['stdout', 'stderr']) {
          const representations = entry.representations[name]
          writeFileSync(join(path, `child-${index}-${name}-representations.json`), JSON.stringify(representations, null, 2))
          const exact = representations.every(chunk => chunk.format === 'buffer')
          writeFileSync(join(path, `child-${index}-${name}.${exact ? 'native' : 'derived-utf8'}.bin`), Buffer.concat(entry.bytes[name]))
        }
      })
      writeFileSync(join(path, 'ownership.json'), JSON.stringify({ hostPid: process.pid, failures: this.failures.map(String), operations: this.operations, audits: this.audits,
        entries: this.entries.map(({ child, timer: _timer, eof, bytes: _bytes, representations, errors, ...entry }) => ({ ...entry, formats: Object.fromEntries(Object.entries(representations).map(([key, chunks]) => [key, chunks.map(chunk => chunk.format === 'string' ? `decoded-string:${chunk.encoding}` : 'native-buffer')])), eof: [...eof], errors: errors.map(String),
          spawnfile: child?.spawnfile, spawnargs: child?.spawnargs, killed: child?.killed })) }, null, 2))
    } catch (error) { this.fail(error); throw error }
  }
}

/** JSON.parse alone loses duplicate keys; validate every object before parsing. */
export function strictFrame(line: string): Record<string, unknown> {
  let i = 0
  const ws = () => { while (/\s/.test(line[i] ?? '') && i < line.length) i++ }
  const string = (): string => {
    const start = i++
    while (i < line.length) { const char = line[i++]; if (char === '\\') i++; else if (char === '"') return JSON.parse(line.slice(start, i)) }
    throw new Error('unterminated string')
  }
  const value = (): void => {
    ws()
    if (line[i] === '{') {
      i++; ws(); const keys = new Set<string>()
      if (line[i] === '}') { i++; return }
      while (true) {
        ws(); if (line[i] !== '"') throw new Error('invalid key')
        const key = string(); if (keys.has(key)) throw new Error('duplicate field'); keys.add(key)
        ws(); if (line[i++] !== ':') throw new Error('invalid object'); value(); ws()
        const end = line[i++]; if (end === '}') return; if (end !== ',') throw new Error('invalid object')
      }
    }
    if (line[i] === '[') {
      i++; ws(); if (line[i] === ']') { i++; return }
      while (true) { value(); ws(); const end = line[i++]; if (end === ']') return; if (end !== ',') throw new Error('invalid array') }
    }
    if (line[i] === '"') { string(); return }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i))
    if (!token) throw new Error('invalid token'); i += token[0].length
  }
  value(); ws(); if (i !== line.length) throw new Error('trailing JSON')
  return JSON.parse(line)
}

export function auditWorker(bytes: Buffer, digest: string, cancelled: boolean, probe: boolean): Record<string, unknown>[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.endsWith('\n')) throw new Error('truncated protocol')
  const frames = text.slice(0, -1).split('\n').map(strictFrame)
  const hello = frames[0], nonce = hello?.nonce
  if (hello?.type !== 'hello' || hello.sha256 !== digest || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('hello mismatch')
  const allowed = probe ? ['hello', 'probe'] : ['hello', 'progress', 'prepared', 'started', 'output', 'root', 'settled']
  for (const frame of frames) if (frame.v !== 1 || frame.nonce !== nonce || !allowed.includes(String(frame.type))) throw new Error('invalid raw frame')
  const lifecycle = frames.filter(frame => frame.type !== 'progress' && frame.type !== 'output').map(frame => frame.type)
  if (JSON.stringify(lifecycle) !== JSON.stringify(probe ? ['hello', 'probe'] : ['hello', 'prepared', 'started', 'root', 'settled'])) throw new Error('lifecycle count/order')
  if (probe) { if (frames[1].available !== true) throw new Error('probe unavailable') }
  else {
    const root = frames.find(frame => frame.type === 'root')!
    if (cancelled ? root.exitCode !== null || root.signal !== 'KILL' : root.exitCode !== 0 || root.signal !== undefined) throw new Error('root mismatch')
    const settled = frames.findIndex(frame => frame.type === 'settled')
    if (settled !== frames.length - 1) throw new Error('late frame')
    const start = frames.findIndex(frame => frame.type === 'started')
    if (frames.some((frame, index) => frame.type === 'output' && (index < start || index >= settled))) throw new Error('output ordering')
  }
  return frames
}

// Read only exact reported identities/lineage. Never signals or opens control handles.
export const IDENTITY_HELPER = `import os,sys,json,base64
p=json.loads(base64.b64decode(sys.argv[1])); base='/proc/'
def ident(pid):
 s=open(base+str(pid)+'/stat').read().rsplit(')',1)[1].split()
 a=open(base+str(pid)+'/cmdline','rb').read().split(b'\\0')[:-1]
 out={'pid':pid,'parent':int(s[1]),'start':s[19],'exe':os.readlink(base+str(pid)+'/exe'),'argv':[x.decode() for x in a]}
 if open(base+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]!=out['start'] or open(base+str(pid)+'/cmdline','rb').read().split(b'\\0')[:-1]!=a or os.readlink(base+str(pid)+'/exe')!=out['exe']: raise ValueError('changed lifetime')
 return out
if p['mode']=='check':
 alive=[]
 for old in p['owned']:
  try:
   now=ident(old['pid'])
   if now['start']==old['start']: alive.append(now)
  except FileNotFoundError: pass
 print(json.dumps({'survivors':alive}))
else:
 w=ident(p['pid'])
 if w['argv']!=p['argv'] or w['exe']!=os.path.realpath('/usr/bin/python3'): raise ValueError('original worker mismatch')
 if p.get('start') and w['start']!=p['start']: raise ValueError('worker replaced')
 owned=[w]; pending=[w]
 if p['mode']=='tree':
  while pending:
   parent=pending.pop()
   for value in open(base+str(parent['pid'])+'/task/'+str(parent['pid'])+'/children').read().split():
    child=ident(int(value))
    if child['parent']!=parent['pid']: raise ValueError('edge changed')
    owned.append(child);pending.append(child)
  if not any(x['pid']==p['root'] for x in owned): raise ValueError('reported root absent')
 print(json.dumps({'worker':w,'owned':owned}))
`
