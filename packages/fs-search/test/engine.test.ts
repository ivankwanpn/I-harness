import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { resolveRgPath, normalizeSearchQuery } from '../src/index.ts'
import { runByteSearch, decodeSearchText, type SearchSnapshot } from '../src/engine.mjs'
import { runScopedModelSearch } from '../src/model-search.ts'
import { createContext } from '@i-harness/core-plugin'
import { registerExec, type ExecService, type ExecCommand, type ExecStreamRunOptions } from '@i-harness/exec'

async function* snapshots(bytes: Uint8Array, path = 'source.txt') { yield { path, bytes, eof: true } }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('fixed stdin search engine', () => {
  it.each([
    {bytes:'\uFEFFneedle\r\n',line:1,column:0,endColumn:6,text:'needle',context:[]},
    {bytes:'first\r\n\uFEFFneedle\r\n\uFEFFafter\r\n',line:2,column:1,endColumn:7,text:'\uFEFFneedle',context:[{line:1,text:'first'},{line:3,text:'\uFEFFafter'}]},
  ])('preserves embedded U+FEFF while stripping only the file BOM at line $line',async({bytes,line,column,endColumn,text,context})=>{
    const result=await runByteSearch({rgPath:await resolveRgPath(),query:{pattern:'needle',before:1,after:1},files:snapshots(Buffer.from(bytes))})
    expect(result.matches).toEqual([expect.objectContaining({line,column,endColumn,endLine:line,text,context})])
  })

  it('preserves U+FEFF across multiline ranges and surrounding context',async()=>{
    const result=await runByteSearch({rgPath:await resolveRgPath(),query:{pattern:'needle\\r?\\n\uFEFFnext',multiline:true,before:1,after:1},files:snapshots(Buffer.from('\uFEFFfirst\r\n\uFEFFneedle\r\n\uFEFFnext\r\n\uFEFFafter\r\n'))})
    expect(result.matches).toEqual([expect.objectContaining({line:2,column:1,endLine:3,endColumn:5,text:'\uFEFFneedle\n\uFEFFnext',context:[{line:1,text:'first'},{line:4,text:'\uFEFFafter'}]})])
  })
  it('accepts actual byte views from another realm without admitting arbitrary objects', async () => {
    const bytes = runInNewContext('Uint8Array.from([110,101,101,100,108,101,10])') as Uint8Array
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, files: snapshots(bytes) })
    expect(result.matches).toContainEqual(expect.objectContaining({ text: 'needle', path: 'source.txt' }))
    const invalid = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, files: snapshots({ byteLength: 7, buffer: bytes.buffer } as Uint8Array) })
    expect(invalid).toMatchObject({ matches: [], status: 'error', reasons: ['invalid-snapshot'] })
  })
  it('decodes Base64 invalid UTF8 without losing text or using the stdin path', async () => {
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, files: snapshots(Buffer.from([255, ...Buffer.from('needle  \t\r\n')]), 'actual.txt') })
    expect(result.matches).toEqual([expect.objectContaining({ path: 'actual.txt', text: '�needle  \t', line: 1, column: 1, endColumn: 7 })])
    expect(result.status).toBe('completed')
  })

  it('preserves valid rows from a PCRE2 exit2 instead of replacing them with empty output', async () => {
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle|^(a+)+$', regexEngine: 'pcre2' }, files: snapshots(Buffer.from(`needle\n${'a'.repeat(100000)}!\n`)) })
    expect(result.matches).toContainEqual(expect.objectContaining({ text: 'needle', line: 1 }))
    expect(result).toMatchObject({ status: 'error', partial: true, error: expect.any(String), diagnostics: expect.arrayContaining([expect.any(String)]) })
  })

  it('bounds escaped JSON amplification independently from result and snapshot bytes', async () => {
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, limits: { maxEngineRawBytes: 4096 }, files: snapshots(Buffer.from(`needle${'\x01'.repeat(20000)}\n`)) })
    expect(result).toMatchObject({ status: 'limited', reasons: expect.arrayContaining(['engine-raw-limit']) })
    expect(result.stats.engineRawBytes).toBe(4096)
    expect(result.stats.runnerRawBytes).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144)
  })

  it('drains a pending producer after another worker fails before resolving', async () => {
    let unlock!: () => void, entered!: () => void, resolved = false, next = 0
    const held = new Promise<void>((r) => { unlock = r }), errorSeen = new Promise<void>((r) => { entered = r })
    const files: AsyncIterableIterator<SearchSnapshot> = {
      async next() {
        if (next++ === 0) { await held; return { done: true, value: undefined } }
        entered(); throw new Error('reader failed')
      },
      async return() { return { done: true, value: undefined } }, [Symbol.asyncIterator]() { return this },
    }
    const pending = runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, files }).then((r) => { resolved = true; return r })
    try {
      await errorSeen; await tick(); await tick()
      expect(resolved).toBe(false)
    } finally { unlock() }
    expect(await pending).toMatchObject({ status: 'error', error: 'reader failed' })
  })

  it('contains a synchronous producer close failure in the bounded result',async()=>{
    const files:AsyncIterableIterator<SearchSnapshot>={async next(){return{done:true,value:undefined}},return(){throw new Error('reader close failed')},[Symbol.asyncIterator](){return this}}
    await expect(runByteSearch({rgPath:await resolveRgPath(),query:{pattern:'needle'},files})).resolves.toMatchObject({status:'error',partial:true,error:'reader close failed',reasons:['reader-close-error']})
  })

  it.each([
    ['utf16be', Buffer.from([254,255,0,65,0,13,0,10,0,66]), 'A\nB'],
    ['windows1252', Buffer.from([128,13,10,233]), '€\né'],
    ['latin1', Buffer.from([128,13,10,233]), '\x80\né'],
  ] as const)('uses the same %s decode in preview and UTF16 editor positions', async (encoding, bytes, text) => {
    expect(decodeSearchText(bytes, encoding)).toEqual({ text, encoding })
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: text.split('\n')[1]!, encoding }, files: snapshots(bytes) })
    expect(result.matches).toContainEqual(expect.objectContaining({ line: 2, column: 0, endColumn: 1, text: text.split('\n')[1] }))
  })

  it('rejects nonnavigable snapshots rather than fabricating a source path', async () => {
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle' }, files: snapshots(Buffer.from('needle\n'), '\uD800') })
    expect(result).toMatchObject({ matches: [], partial: true, status: 'error', reasons: ['invalid-snapshot'] })
  })

  it('does not show a phantom context line after a terminal newline', async () => {
    const result = await runByteSearch({ rgPath: await resolveRgPath(), query: { pattern: 'needle', after: 1 }, files: snapshots(Buffer.from('needle\n')) })
    expect(result.matches[0]?.context).toEqual([])
  })
})

describe('descriptor snapshot budgets', () => {
  it('does not count a replaced non-file candidate as a completed file search',async()=>{
    const root=mkdtempSync(join(tmpdir(),'read-not-file-')), target=join(root,'source.txt'), exec=registerExec(createContext()),original=exec.run.bind(exec)
    writeFileSync(target,'needle\n')
    exec.run=((command:ExecCommand,options?:ExecStreamRunOptions|{backgroundAfterMs?:number})=>{
      if(command.argv.some((arg)=>arg.endsWith('reader.mjs'))) {renameSync(target,join(root,'old'));mkdirSync(target)}
      return options===undefined?original(command):'stream'in options?original(command,options):original(command,options)
    }) as ExecService['run']
    try {
      const result=await runScopedModelSearch({exec,rgPath:await resolveRgPath(),cwd:root,root:'.',kind:'grep',query:normalizeSearchQuery({pattern:'needle'})})
      expect(result).toMatchObject({status:'error',matches:[],reasons:expect.arrayContaining(['file-read-error']),stats:{candidateFiles:1,attemptedFiles:1,readFiles:0,completedFiles:0,inputBytes:0}})
    } finally {rmSync(root,{recursive:true,force:true})}
  })
  it('reserves the concurrent last byte before awaits and admits no extra EOF probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byte-reservation-'))
    const names = Array.from({ length: 4 }, (_, n) => ({ path: `${n}.txt`, absolute: join(root, `${n}.txt`) }))
    for (const name of names) writeFileSync(name.absolute, Buffer.alloc(512, 65))
    try {
      const result = await runScopedModelSearch({exec:registerExec(createContext()),rgPath:await resolveRgPath(),cwd:root,root:'.',kind:'grep',query:normalizeSearchQuery({pattern:'^A'}),limits:{maxInputBytes:513,maxFileBytes:512}})
      expect(result.matches.reduce((n,m)=>n+m.text.length,0)).toBe(513)
      expect(result.stats.inputBytes).toBe(513)
      expect(result.stats.eofFiles).toBe(0)
      expect(result.reasons).toContain('input-byte-limit')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reclaims unused concurrent reservations and counts EOF only after a zero read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byte-reclaim-'))
    const names = Array.from({ length: 4 }, (_, n) => ({ path: `${n}.txt`, absolute: join(root, `${n}.txt`) }))
    names.forEach((name, n) => writeFileSync(name.absolute, Buffer.alloc(n, 65)))
    try {
      const result=await runScopedModelSearch({exec:registerExec(createContext()),rgPath:await resolveRgPath(),cwd:root,root:'.',kind:'grep',query:normalizeSearchQuery({pattern:'A'}),limits:{maxInputBytes:10,maxFileBytes:100}})
      expect(result.stats).toMatchObject({inputBytes:6,eofFiles:4,readFiles:4})
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('normalizes the direct and human result ceilings independently and rejects hidden flags', () => {
    expect(normalizeSearchQuery({ pattern: 'needle' }, { profile: 'grep' }).maxResultBytes).toBe(32768)
    expect(normalizeSearchQuery({ pattern: 'needle' }, { profile: 'human' }).maxResultBytes).toBe(262144)
    expect(() => normalizeSearchQuery({ pattern: 'x', flags: ['--pre=cmd'] } as never)).toThrow(/unsupported/)
    expect(() => normalizeSearchQuery({ pattern: 'x', includes: Array(16).fill('x'.repeat(512)) })).toThrow(/combined/)
  })
})
