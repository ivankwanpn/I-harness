import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({onStart: () => {}, records: [] as any[], inherit:vi.fn(), acquire:vi.fn()}))
vi.mock('../src/pipe-child.ts', () => ({ createPipeChildOwner: vi.fn((input, original) => {
  let pending=true, resolve!: (v:any)=>void, reject!: (e:unknown)=>void
  const result=new Promise<any>((a,b)=>{resolve=a;reject=b})
  const record={input,original,start() {state.onStart();return result},async joinCleanup() {await result.catch(()=>{});pending=false},pending:()=>pending,resolve,reject}
  state.records.push(record);return record
}) }))
vi.mock('../src/native-wait-bridge.ts', () => ({acquireWaitDrainBridgeClient:state.acquire}))
vi.mock('../src/spawn.ts', async original => ({...await original<any>(),spawnSandboxedInherited:state.inherit}))
import { AclSandbox } from '../src/index.ts'
function sandbox() {
  const box=new AclSandbox({mode:'read-only',writableDirs:[],tempDir:null})
  const internals=box as any
  internals.ready=true;internals.api={};internals.token=1n;internals.logonSid='S-1-5-5-1-2'
  internals.initOwner={cleanupScopes:vi.fn(),cleanup:vi.fn()}
  return {box,internals}
}
beforeEach(()=>{state.records=[];state.onStart=()=>{};state.inherit.mockReset();state.acquire.mockReset()})
describe('actual sandbox pipe admission',()=>{
  it('registers the original record before start and copies caller argv',async()=>{
    const {box,internals}=sandbox(),args=['x'];state.onStart=()=>expect(internals.pipeChildren.has(state.records[0])).toBe(true)
    const child={pid:7,wait:()=>Promise.resolve({stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:0})}
    const start=box.spawn({command:'cmd',args});args.push('changed');expect(state.records[0].input.args).toEqual(['x']);state.records[0].resolve(child);expect(await start).toBe(child);await box.disposeAsync();expect(internals.initOwner.cleanup).toHaveBeenCalledTimes(1)
  })
  it('busy synchronous dispose mutates neither closing nor original token/grants',async()=>{
    const {box,internals}=sandbox();const start=box.spawn({command:'cmd'});expect(()=>box.dispose()).toThrow('disposeAsync');expect(internals.closing).toBe(false);expect(internals.initOwner.cleanup).not.toHaveBeenCalled();expect(internals.token).toBe(1n)
    const disposal=box.disposeAsync();expect(()=>box.spawn({command:'cmd'})).toThrow('initialized');expect(internals.initOwner.cleanup).not.toHaveBeenCalled();state.records[0].reject(new Error('startup'));await expect(start).rejects.toThrow('startup');await disposal
  })
  it('retains failed prepublication debt and reaches it through disposal',async()=>{
    const {box,internals}=sandbox();const start=box.spawn({command:'cmd'}),record=state.records[0];record.joinCleanup=vi.fn(async()=>{throw 0});record.reject(false);await expect(start).rejects.toBe(false);await expect(box.disposeAsync()).rejects.toBeInstanceOf(AggregateError);expect(internals.initOwner.cleanup).not.toHaveBeenCalled();expect(internals.pipeChildren.has(record)).toBe(true)
  })
  it('literal inherit remains synchronous and never acquires a pipe child/client',()=>{
    const {box}=sandbox();state.inherit.mockReturnValue({pid:9,process:2n,job:3n});const child=box.spawn({command:'cmd',stdio:'inherit'});expect(child.pid).toBe(9);expect(child).not.toBeInstanceOf(Promise);expect(state.records).toHaveLength(0);expect(state.acquire).not.toHaveBeenCalled();box.dispose()
  })
})
