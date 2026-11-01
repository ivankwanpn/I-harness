import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({onStart: () => {}, records: [] as any[], inherit:vi.fn(), acquire:vi.fn()}))
vi.mock('../src/pipe-child.ts', () => ({ createPipeChildOwner: vi.fn((input, original) => {
  let pending=true, resolve!: (v:any)=>void, reject!: (e:unknown)=>void
  const result=new Promise<any>((a,b)=>{resolve=a;reject=b})
  const record={input,original,start() {state.onStart();return result},async joinCleanup() {await result.catch(()=>{});pending=false},pending:()=>pending,resolve,reject}
  state.records.push(record);return record
}) }))
vi.mock('../src/native-wait-bridge.ts', () => ({acquireWaitDrainBridgeClient:state.acquire}))
vi.mock('../src/inherited-child.ts', () => ({createInheritedChildOwner:state.inherit}))
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
  it('literal inherit returns a Promise and admits the original inherited record before start',async()=>{
    const {box,internals}=sandbox();let pending=true;const child={pid:9,wait:async()=>({stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:0})}
    const record={start(){expect(internals.pipeChildren.has(record)).toBe(true);return Promise.resolve(child)},pending:()=>pending,async joinCleanup(){pending=false}}
    state.inherit.mockReturnValue(record);const result=box.spawn({command:'cmd',stdio:'inherit'});expect(result).toBeInstanceOf(Promise);expect(()=>box.dispose()).toThrow('disposeAsync');expect(await result).toBe(child);await box.disposeAsync()
  })
})
