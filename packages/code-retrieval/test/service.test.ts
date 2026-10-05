import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createCodeRetrievalService, createCodeRetrievalTools, type CodeFileSnapshot, type CodeRetrievalService, type CodeSnapshotReader } from '../src/index.ts'
import { createToolRegistry } from '@i-harness/core-tools'
import { createContext } from '@i-harness/core-plugin'

const roots: string[] = [], services: CodeRetrievalService[] = []
async function fixture(extra: Parameters<typeof createCodeRetrievalService>[0]['config'] = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'code-test-'))
  roots.push(root)
  const data: CodeFileSnapshot[] = [
    {sourceId:'workspace',path:'src/auth/approval.ts',revision:'a',complete:true,text:'// 😀 部署批准\nexport function approveDeployment() {\n  return true\n}\n'},
    {sourceId:'reference',path:'src/auth-copy/approval.ts',revision:'b',complete:true,text:'export const approveDeployment = false\n'},
  ]
  let allowed = true
  const reader: CodeSnapshotReader = {
    async *snapshots(_access, options) { for (const file of data) if (!options.sourceIds || options.sourceIds.includes(file.sourceId)) yield {...file} },
    async revalidate(_access, hit) { return allowed && data.some(file=>file.sourceId===hit.sourceId && file.path===hit.path && file.revision===hit.revision) },
  }
  const service = createCodeRetrievalService({root,workspaceId:'w',reader,config:{enabled:true,...extra}})
  services.push(service)
  return {root,data,reader,service,deny:()=>{allowed=false}}
}
async function index(service: CodeRetrievalService, options?: Parameters<CodeRetrievalService['startIndex']>[1]) {
  return service.wait((await service.startIndex({sessionId:'s'},options)).jobId)
}
afterEach(async()=> { await Promise.all(services.splice(0).map(s=>s.close())); await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true}))) })

describe('native code index',()=>{
  it('lazily indexes real SQLite and returns exact contiguous source ranges with scoped identifier and Chinese recall',async()=>{
    const {root,service,data}=await fixture()
    expect(await readdir(root)).toEqual([])
    expect((await index(service)).state).toBe('ready')
    const result=await service.search({sessionId:'s'},{query:'approveDeployment',pathPrefix:'src/auth'})
    expect(result.hits.map(hit=>hit.path)).toEqual(['src/auth/approval.ts'])
    expect(result.hits[0].text).toContain('approveDeployment')
    for(const hit of result.hits) expect(hit.text).toBe(data[0].text.slice(hit.startOffset,hit.endOffset))
    expect((await service.search({sessionId:'s'},{query:'部署批准'})).hits[0].path).toBe('src/auth/approval.ts')
    expect((await service.search({sessionId:'s'},{query:'approve',sourceIds:['reference']})).hits.map(h=>h.sourceId)).toEqual(['reference'])
    expect(await readdir(root)).toEqual(['code-retrieval'])
  })
  it('commits changed and deleted files, survives restart, and suppresses revoked or stale hits',async()=>{
    const {root,service,data,reader,deny}=await fixture()
    await index(service)
    data[0]={...data[0],revision:'c',text:'export const updatedDeployment = true'}
    data.splice(1)
    expect((await service.search({sessionId:'s'},{query:'approveDeployment'})).hits).toEqual([])
    expect((await index(service)).generation).toBe(2)
    await service.close()
    const restarted=createCodeRetrievalService({root,workspaceId:'w',reader,config:{enabled:true}}); services.push(restarted)
    const result=await restarted.search({sessionId:'s'},{query:'updatedDeployment'})
    expect(result.generation).toBe(2); expect(result.hits).toHaveLength(1)
    deny(); expect((await restarted.search({sessionId:'s'},{query:'updatedDeployment'})).hits).toEqual([])
  })
  it('preserves other sources on scoped refresh and reports reader omissions and caps durably',async()=>{
    const {service,data,reader}=await fixture()
    await index(service)
    data.splice(0,1)
    expect((await index(service,{sourceIds:['workspace']})).files).toBe(1)
    reader.status=()=>({partial:true,reasons:['ignored-entry-limit']})
    const capped=await index(service)
    expect(capped.partial).toBe(true); expect(capped.reasons).toContain('ignored-entry-limit')
    const result=await service.search({sessionId:'s'},{query:'approveDeployment',maxBytes:180})
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(180)
    expect(result.partial).toBe(true)
  })
  it('enforces input/file/chunk quotas with committed counts and no discontiguous AST text',async()=>{
    const {service,data}=await fixture({maxFiles:1,maxChunks:2})
    data[0].text='// 😀 comment\n'+Array.from({length:500},(_,i)=>`export function approval${i}() { return "批准" }\n`).join('')
    const state=await index(service)
    expect(state.files).toBe(1); expect(state.chunks).toBe(2); expect(state.partial).toBe(true)
    const result=await service.search({sessionId:'s'},{query:'批准'})
    for(const hit of result.hits) {
      expect(Buffer.byteLength(hit.text)).toBeLessThanOrEqual(4096)
      expect(hit.text).toBe(data[0].text.slice(hit.startOffset,hit.endOffset))
      expect(hit.startLine).toBe(data[0].text.slice(0,hit.startOffset).split('\n').length)
      expect(hit.endLine).toBe(data[0].text.slice(0,Math.max(hit.startOffset,hit.endOffset-1)).split('\n').length)
    }
  })
  it('clear and disable wait for held source IO and fence late completion',async()=>{
    const {service,reader}=await fixture(); await index(service)
    let release!:()=>void, entered!:()=>void
    const gate=new Promise<void>(r=>{release=r}), started=new Promise<void>(r=>{entered=r})
    reader.snapshots=async function*(){entered(); await gate; yield {sourceId:'workspace',path:'late.ts',revision:'late',text:'lateWrite',complete:true}}
    const {jobId}=await service.startIndex({sessionId:'s'}); await started
    let done=false
    const clearing=service.clear().then(s=>{done=true;return s})
    await new Promise(r=>setTimeout(r,20)); expect(done).toBe(false); expect(service.status().state).toBe('stopping')
    release(); expect((await clearing).files).toBe(0); await service.wait(jobId)
    expect(service.status().generation).toBe(0)
    await service.configure({enabled:false}); expect(service.status().state).toBe('disabled')
    await expect(service.startIndex({sessionId:'s'})).rejects.toThrow(/disabled/)
  })
  it('expanding a chunk cap restores chunks from the full admitted snapshot',async()=>{
    const {service,data}=await fixture({maxChunks:1})
    data[0].text='const filler = "'+ 'x'.repeat(5000)+'";\nexport function distantNeedle() {}'
    await index(service)
    await service.configure({maxChunks:10})
    const state=await index(service)
    expect(state.partial).toBe(false)
    expect((await service.search({sessionId:'s'},{query:'distantNeedle'})).hits).toHaveLength(1)
  })
  it('rolls back an actual SQLite write failure and retries the old generation',async()=>{
    const {service,root,data}=await fixture();await index(service)
    const db=new DatabaseSync(resolve(root,'code-retrieval',createHash('sha256').update('w').digest('hex'),'index.sqlite'))
    try {
      db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END")
      data[0]={...data[0],revision:'next',text:'export const updatedNeedle = true'}
      const failed=await index(service)
      expect(failed.state).toBe('error');expect(failed.generation).toBe(1);expect(failed.files).toBe(2)
      expect(db.prepare('SELECT text FROM chunks WHERE source=?').get('workspace')).toMatchObject({text:expect.stringContaining('approveDeployment')})
      db.exec('DROP TRIGGER fail_write')
      expect((await index(service)).generation).toBe(2)
      expect((await service.search({sessionId:'s'},{query:'updatedNeedle'})).hits).toHaveLength(1)
    } finally {db.close()}
  })
  it('immediate cancel drains the scheduled job and permits another index',async()=>{
    const {service}=await fixture()
    const pending=service.startIndex({sessionId:'s'})
    await service.cancel()
    const {jobId}=await pending
    await service.wait(jobId)
    expect(service.status().activeJobs).toBe(0)
    expect((await index(service)).state).toBe('ready')
  })
  it('registers native deferred tools and derives session authority only from ToolExec',async()=>{
    const {service,reader}=await fixture()
    let admitted=''
    const original=reader.snapshots.bind(reader)
    reader.snapshots=async function*(access,input){admitted=access.sessionId;yield* original(access,input)}
    const tools=createCodeRetrievalTools(service),registry=createToolRegistry(createContext())
    for(const tool of tools)registry.register(tool)
    expect(registry.deferredToolCount()).toBe(3)
    expect(registry.get('code_context_index')).toMatchObject({isReadOnly:false,isConcurrencySafe:false})
    expect(registry.get('code_context_search')).toMatchObject({isReadOnly:true,isConcurrencySafe:true})
    await expect(registry.prepare({name:'code_context_index',args:{sessionId:'forged'}})).rejects.toThrow()
    await expect(registry.get('code_context_index')!.execute({},{})).rejects.toThrow(/session/)
    const prepared=await registry.prepare({name:'code_context_index',args:{}},undefined,{sessionId:'trusted'})
    const result=await registry.dispatch(prepared) as {jobId:string}
    await service.wait(result.jobId);expect(admitted).toBe('trusted')
    await expect(registry.get('code_context_search')!.execute({query:'approve',sessionId:'forged'},{sessionId:'trusted'})).rejects.toThrow()
  })
  it('rejects an impossible disk budget before creating an index',async()=>{
    const {root,service}=await fixture({maxDiskBytes:1})
    const state=await index(service);expect(state.state).toBe('error');expect(state.generation).toBe(0)
    expect(await readdir(root)).toEqual([])
  })
  it('awaits held revalidation before disabling and never returns late search text',async()=>{
    const {service,reader}=await fixture();await index(service)
    let release!:(value:boolean)=>void,entered!:()=>void
    const started=new Promise<void>(r=>{entered=r})
    reader.revalidate=async()=>{entered();return new Promise<boolean>(r=>{release=r})}
    const pending=service.search({sessionId:'s'},{query:'approveDeployment'})
    const outcome=pending.catch(error=>error)
    await started
    let done=false
    const disabled=service.configure({enabled:false}).then(s=>{done=true;return s})
    await new Promise(r=>setTimeout(r,15));expect(done).toBe(false)
    release(true);await disabled;expect(await outcome).toBeInstanceOf(Error);expect(service.status().activeJobs).toBe(0)
  })
  it('incremental refresh avoids rewriting unchanged lexical rows',async()=>{
    const {service,root,data}=await fixture();await index(service)
    const db=new DatabaseSync(resolve(root,'code-retrieval',createHash('sha256').update('w').digest('hex'),'index.sqlite'))
    try {
      db.exec('CREATE TABLE audit (writes INTEGER); INSERT INTO audit VALUES(0); CREATE TRIGGER count_write AFTER INSERT ON chunks BEGIN UPDATE audit SET writes=writes+1; END')
      await index(service)
      expect(db.prepare('SELECT writes FROM audit').get()).toEqual({writes:0})
      data[0]={...data[0],text:'const newDeployment = true',revision:'next'}
      await index(service)
      expect(db.prepare('SELECT writes FROM audit').get()).toEqual({writes:1})
    } finally {db.close()}
  })
  it('scoped updates reserve total file and chunk capacity for preserved sources',async()=>{
    const {service}=await fixture();await index(service)
    await service.configure({maxFiles:1,maxChunks:1})
    const state=await index(service,{sourceIds:['workspace']})
    expect(state.files).toBe(1);expect(state.chunks).toBe(1);expect(state.partial).toBe(true)
    expect((await service.search({sessionId:'s'},{query:'approveDeployment',sourceIds:['reference']})).hits).toHaveLength(1)
  })
  it('serializes concurrent configuration patches without losing earlier changes',async()=>{
    const {service}=await fixture()
    await Promise.all([service.configure({enabled:false}),service.configure({maxFiles:3})])
    expect(service.status().enabled).toBe(false);expect(service.status().config.maxFiles).toBe(3)
  })
  it('reports file and input quotas and preserves exact CRLF fallback ranges',async()=>{
    const {service,data}=await fixture({maxFileBytes:20,maxInputBytes:15})
    data.splice(0,data.length,
      {sourceId:'w',path:'large.py',revision:'a',complete:true,text:'x'.repeat(21)},
      {sourceId:'w',path:'a.py',revision:'b',complete:true,text:'😀\r\n批准\r\n'},
      {sourceId:'w',path:'b.py',revision:'c',complete:true,text:'more bytes here'},
    )
    const state=await index(service)
    expect(state.files).toBe(1);expect(state.reasons).toEqual(expect.arrayContaining(['max-file-bytes','max-input-bytes']))
    const result=await service.search({sessionId:'s'},{query:'批准'})
    expect(result.hits[0]).toMatchObject({text:'😀\r\n批准\r\n',startLine:1,endLine:2,startOffset:0,endOffset:8})
  })
  it('enforces the wall clock deadline even when a reader blocks the event loop',async()=>{
    const {service,reader}=await fixture();await index(service)
    await service.configure({deadlineMs:10})
    reader.snapshots=async function*(){const until=Date.now()+25;while(Date.now()<until){/* controlled CPU work */}yield {sourceId:'w',path:'late.ts',text:'late',revision:'late',complete:true}}
    const state=await index(service)
    expect(state.generation).toBe(1);expect(state.error).toMatch(/deadline/)
  })
})
