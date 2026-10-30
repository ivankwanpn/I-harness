import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
vi.mock('node:crypto', async original => { const actual = await original<typeof import('node:crypto')>(); return { ...actual, randomUUID: vi.fn(actual.randomUUID) } })
import { createExecServiceWithReservation } from '../src/service.ts'

it.each(['reserve', 'instanceId', 'release', 'start'] as const)('refuses foreign %s receivers before any reservation or command operation', async method => {
  const a = createExecServiceWithReservation(), b = createExecServiceWithReservation()
  let reads = 0
  const command = Object.defineProperty({}, 'argv', { get() { reads++; return [] } }) as any
  const options = Object.defineProperty({}, 'signal', { get() { reads++; return undefined } })
  try {
    for (const receiver of [undefined, {}, { ...a.port }, b.port]) {
      const handle = a.port.reserve(), instanceId = a.port.instanceId(handle)
      const allocations = vi.mocked(randomUUID).mock.calls.length
      const args = method === 'reserve' ? [] : method === 'start' ? [handle, command, 'foreground', options] : [handle]
      const invoke = () => Reflect.apply(a.port[method], receiver, args)
      if (method === 'start') await expect(invoke()).rejects.toThrow(/receiver/)
      else expect(invoke).toThrow(/receiver/)
      expect(reads).toBe(0)
      expect(vi.mocked(randomUUID).mock.calls.length).toBe(allocations)
      expect(a.port.instanceId(handle)).toBe(instanceId)
      a.port.release(handle)
      expect(() => a.port.instanceId(handle)).toThrow()
    }
    expect(a.service.listJobViews()).toEqual([])
    expect(b.service.listJobViews()).toEqual([])
  } finally { await a.service.dispose(); await b.service.dispose() }
})

it('fences post-dispose start and reserve before command reads or allocation while cleanup release remains available', async () => {
  const pair = createExecServiceWithReservation(), handle = pair.port.reserve()
  let reads = 0
  const command = Object.defineProperty({}, 'argv', { get() { reads++; return [] } }) as any
  await pair.service.dispose()
  const allocations = vi.mocked(randomUUID).mock.calls.length
  expect(() => pair.port.reserve()).toThrow()
  await expect(pair.port.start(handle, command, 'background')).rejects.toThrow()
  expect(reads).toBe(0)
  expect(vi.mocked(randomUUID).mock.calls.length).toBe(allocations)
  expect(pair.service.listJobViews()).toEqual([])
  pair.port.release(handle)
})

it('rejects copied, foreign and reused reservations before reading a command', async () => {
  const a = createExecServiceWithReservation(), b = createExecServiceWithReservation()
  const handle = a.port.reserve(), copied = { ...handle }; let reads = 0
  const command = Object.defineProperty({}, 'argv', { get() { reads++; return [] } }) as any
  await expect(a.port.start(copied, command, 'background')).rejects.toThrow()
  await expect(b.port.start(handle, command, 'background')).rejects.toThrow()
  expect(reads).toBe(0)
  await expect(a.port.start(handle, command, 'foreground')).rejects.toThrow()
  const after = reads
  await expect(a.port.start(handle, command, 'background')).rejects.toThrow()
  expect(reads).toBe(after)
  await a.service.dispose(); await b.service.dispose()
})

it('uses the reserved instance for one real controlled background capture', async () => {
  const { createExecutionLease } = await import('@i-harness/sandbox')
  const { compileExecutionPolicy } = await import('@i-harness/sandbox-policy')
  const { resolve } = await import('node:path')
  let launches = 0
  const backend: import('@i-harness/sandbox').TransportExecutionBackend = {
    async probe() { return { id:'controlled',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true} } },
    async prepare(spec, policy) { return {policy, async rollback(){}, async commit(check) {
      check(); launches++
      const lease=createExecutionLease({receipt:{executionId:'one',backendId:'controlled',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:Promise.resolve({exitCode:0}),async waitTreeEmpty(){},async settleIo(){},async releaseResources(){},async terminate(){}})
      return {...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){},output:(async function*(){})()}}
    }} },
  }
  const pair=createExecServiceWithReservation({execution:{defaultOwner:{sessionId:'s'},selectBackend:()=>backend,validateAuthority(){},resolvePolicy:owner=>compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'r',workspaceRoot:resolve('.')}})}})
  const reservation=pair.port.reserve()
  const reservedId=pair.port.instanceId(reservation)
  expect(reservedId).toBe(vi.mocked(randomUUID).mock.results.at(-1)?.value)
  const foreign=createExecServiceWithReservation()
  let commandReads=0
  const command=Object.defineProperty({},'argv',{get(){commandReads++;return ['controlled']}}) as any
  const allocations=vi.mocked(randomUUID).mock.calls.length
  try {
    for(const receiver of [undefined,{...pair.port},foreign.port]) {
      await expect(Reflect.apply(pair.port.start,receiver,[reservation,command,'background'])).rejects.toThrow(/receiver/)
      expect(()=>Reflect.apply(pair.port.release,receiver,[reservation])).toThrow(/receiver/)
      expect(pair.port.instanceId(reservation)).toBe(reservedId)
      expect(launches).toBe(0);expect(commandReads).toBe(0)
      expect(vi.mocked(randomUUID).mock.calls.length).toBe(allocations)
    }
  } finally { await foreign.service.dispose() }
  const result=await pair.port.start(reservation,command,'background')
  expect(result).toHaveProperty('nativeJob.instanceId', reservedId)
  expect(launches).toBe(1)
  expect(commandReads).toBeGreaterThan(0)
  await expect(pair.port.start(reservation,{argv:['controlled']},'background')).rejects.toThrow()
  expect(launches).toBe(1)
  const disposedReservation=pair.port.reserve()
  await pair.service.dispose()
  const readsAfterDispose=commandReads, allocationsAfterDispose=vi.mocked(randomUUID).mock.calls.length
  await expect(pair.port.start(disposedReservation,command,'background')).rejects.toThrow()
  expect(()=>pair.port.reserve()).toThrow()
  expect(commandReads).toBe(readsAfterDispose)
  expect(launches).toBe(1)
  expect(vi.mocked(randomUUID).mock.calls.length).toBe(allocationsAfterDispose)
  pair.port.release(disposedReservation)
})

it('releases unused reservations and prevents concurrent starts', async () => {
  const pair=createExecServiceWithReservation(), unused=pair.port.reserve()
  pair.port.release(unused)
  expect(()=>pair.port.release(unused)).toThrow()
  const handle=pair.port.reserve(); let reads=0
  const command=Object.defineProperty({},'argv',{get(){reads++;return []}}) as any
  const first=pair.port.start(handle,command,'foreground')
  const before=reads
  await expect(pair.port.start(handle,command,'background')).rejects.toThrow()
  expect(reads).toBe(before)
  await expect(first).rejects.toThrow()
  await pair.service.dispose()
})
