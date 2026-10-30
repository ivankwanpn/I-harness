import { expect, it } from 'vitest'
import { createWaitBridgeOwner } from '../src/native-wait-bridge-owner.ts'
import { createWaitDrainService } from '../src/native-wait-bridge.ts'
import { EventEmitter } from 'node:events'
import type { NativePtr } from '../src/ffi.ts'

it('shares the original worker, fences leases and joins exit before replacement', async () => {
  class Port extends EventEmitter { messages: any[] = []; postMessage(m: any) { this.messages.push(m) } }
  const ports: Port[] = []
  const owner = createWaitBridgeOwner(async () => { const port = new Port(); ports.push(port); const service = createWaitDrainService(port, 'e'); port.emit('message', { type: 'ready', epoch: 'e' }); return service })
  const a = await owner.acquire('root'), b = await owner.acquire('root')
  const reservation = a.reserve()
  await expect(a.release()).rejects.toThrow(/unresolved/)
  expect(() => a.reserve()).toThrow()
  reservation.release()
  await a.release()
  expect(ports).toHaveLength(1)
  await expect(owner.get('root').then(s => s.close())).rejects.toThrow(/client/)
  const closing = b.release()
  await expect(owner.acquire('root')).rejects.toThrow(/closing/)
  await new Promise(resolve => setImmediate(resolve))
  expect(ports[0].messages.at(-1).type).toBe('shutdown')
  let done = false; void closing.then(() => { done = true })
  ports[0].emit('message', { type: 'shutdown', epoch: 'e' })
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false)
  ports[0].emit('exit', 0); await closing
  const c = await owner.acquire('root'); expect(ports).toHaveLength(2)
  const end = c.release(); await new Promise(resolve => setImmediate(resolve)); ports[1].emit('message', { type: 'shutdown', epoch: 'e' }); ports[1].emit('exit', 0); await end
})

it('retains unknown unregister debt and the original service', async () => {
  class Port extends EventEmitter { postMessage(_m: unknown) {} }
  const port = new Port(); let starts = 0
  const owner = createWaitBridgeOwner(async () => { starts++; const service = createWaitDrainService(port, 'e'); port.emit('message', { type: 'ready', epoch: 'e' }); return service })
  const client = await owner.acquire('root'); const reservation = client.reserve()
  const pending = reservation.unregister(1n as NativePtr)
  await new Promise(resolve => setImmediate(resolve))
  port.emit('message', { type: 'unknown', epoch: 'e', id: '1' })
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' })
  expect(() => reservation.release()).toThrow(/unresolved/)
  await expect(client.release()).rejects.toThrow(/unresolved/)
  const second = await owner.acquire('root'); expect(starts).toBe(1)
  await second.release()
})

it('retains a falsey close failure and retries on the same lease', async () => {
  let attempts = 0, starts = 0
  const owner = createWaitBridgeOwner(async () => { starts++; return { ready: Promise.resolve(), reserve() { throw new Error('unused') }, close() { attempts++; return attempts === 1 ? Promise.reject(undefined) : Promise.resolve() } } })
  const client = await owner.acquire('root')
  await expect(client.release()).rejects.toBeUndefined()
  await expect(owner.acquire('root')).rejects.toThrow(/closing/)
  await client.release(); expect(starts).toBe(1); expect(attempts).toBe(2)
})

