import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, backendControls } from './helpers/composed.ts'
import { compileSemanticSeed } from '../src/semantic-seed.ts'
import type { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import type { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts'

const constructed = vi.hoisted(() => ({ latches: undefined as unknown, managed: undefined as unknown }))
vi.mock('../src/coordinator/process-read-latches.ts', async load => {
  const api = await load<typeof import('../src/coordinator/process-read-latches.ts')>()
  return { ...api, createProcessReadLatches: (...args: Parameters<typeof api.createProcessReadLatches>) => { const value = api.createProcessReadLatches(...args); constructed.latches = value; return value } }
})
vi.mock('../src/coordinator/managed-documents.ts', async load => {
  const api = await load<typeof import('../src/coordinator/managed-documents.ts')>()
  return { ...api, createManagedDocuments: (...args: Parameters<typeof api.createManagedDocuments>) => { const value = api.createManagedDocuments(...args); constructed.managed = value; return value } }
})

it('fences the actual bootstrap target from admission through ready publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-bootstrap-latch-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const coordinator = createSessionCoordinator(backend, options)
  const latches = constructed.latches as ReturnType<typeof createProcessReadLatches>
  const invocation = { version: 1 as const, operationId: 'process-bootstrap', targetSessionId: 'target', createdAt: new Date().toISOString(), requestDigest: 'a'.repeat(64) }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
  const never = async (): Promise<never> => { throw new Error('no dependencies') }
  try {
    const reader = latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })
    const operation = coordinator.bootstrapSemanticTarget(request, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })
    const denied = (() => { try { reader.assertCurrent(); return false } catch { return true } })()
    expect((await operation).kind).toBe('ready'); expect(denied).toBe(true)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the original target witness through a blocked bootstrap and its actual resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-bootstrap-retry-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const original = backendControls(backend).original.prepareBootstrapHeader!
  backendControls(backend).methods.prepareBootstrapHeader = async (...args) => { await original(...args); return { kind: 'unknown' } }
  const coordinator = createSessionCoordinator(backend, options)
  const latches = constructed.latches as ReturnType<typeof createProcessReadLatches>
  const invocation = { version: 1 as const, operationId: 'process-retry', targetSessionId: 'target', createdAt: new Date().toISOString(), requestDigest: 'b'.repeat(64) }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'import' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
  const never = async (): Promise<never> => { throw new Error('no dependencies') }, guards = { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }
  try {
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('blocked')
    expect(() => latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })).toThrow()
    for (let n = 0; n < 12; n++) {
      expect((await coordinator.resumeSemanticTarget({ ...invocation, operationId: `foreign-${n}` }, guards)).kind).toBe('refused')
    }
    backendControls(backend).methods.prepareBootstrapHeader = original
    expect(['ready', 'already-ready']).toContain((await coordinator.resumeSemanticTarget(invocation, guards, request)).kind)
    expect(() => latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })).not.toThrow()
    for (let n = 0; n < 12; n++) {
      expect((await coordinator.resumeSemanticTarget({ ...invocation, operationId: `foreign-ready-${n}` }, guards)).kind).toBe('refused')
    }
    expect(() => latches.capture({ sessionId: 'target', documentKeys: [], mode: 'cold' })).not.toThrow()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
import { createSelectedResultsIntent,readSelectedResultsCore } from '../src/selected-results-fork-contract.ts'
it('fences selected target before binding admission can await another owner',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-latch-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),latches=constructed.latches as ReturnType<typeof createProcessReadLatches>,managed=constructed.managed as ReturnType<typeof createManagedDocuments>
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),route={protocol:'public-results-v1' as const,request:{core,requestIntent:intent,invocation:{version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}}
 try{const reader=latches.capture({sessionId:'target',documentKeys:[],mode:'cold'});const identity={};managed.prepareSelectedCapture(route,identity,()=>{},async()=>({}));expect(()=>reader.assertCurrent()).toThrow();expect(()=>managed.prepareSelectedCapture(route,{},()=>{},async()=>({}))).toThrow('conflict');await managed.releaseSelected(route,{});expect(()=>latches.capture({sessionId:'target',documentKeys:[],mode:'cold'})).toThrow();await managed.releaseSelected(route,identity)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
