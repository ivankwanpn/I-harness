import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createSessionService } from '../src/service.ts'

it.each(['acknowledged', 'failed'] as const)('distinguishes retained Stop receipts from %s cleanup work', async outcome => {
  const root = await mkdtemp(join(tmpdir(), 'ih-stop-activity-'))
  const service = createSessionService({ workspace: root, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const drainEntered = Promise.withResolvers<void>(), releaseDrain = Promise.withResolvers<void>()
  const failure = new Error('Original journal cleanup failed')
  let recovered = false, settlementCalls = 0, drainCalls = 0
  try {
    const assembly = await service.assemblyFor('owner')
    const settle = assembly.settleParentDeliveryJournalDebt?.bind(assembly)
    assembly.settleParentDeliveryJournalDebt = async () => {
      settlementCalls++
      entered.resolve(); await release.promise
      if (outcome === 'failed' && !recovered) throw failure
      await settle?.()
    }
    if (outcome === 'acknowledged') {
      const drain = assembly.drainParentNotifications!.bind(assembly)
      assembly.drainParentNotifications = async (...args) => {
        drainCalls++
        await drain(...args)
        drainEntered.resolve()
        await releaseDrain.promise
      }
    }
    expect(service.inspectActivity!('owner').active).toBe(false)
    service.cancelRunning!('owner')
    const stopping = service.awaitDeliveryStop('owner')
    const joined = service.awaitDeliveryStop('owner')
    void stopping.catch(() => {})
    void joined.catch(() => {})
    await entered.promise
    expect(settlementCalls).toBe(1)
    expect(service.inspectActivity!('owner').active).toBe(true)
    release.resolve()
    if (outcome === 'failed') {
      await expect(stopping).rejects.toBe(failure)
      await expect(joined).rejects.toBe(failure)
      expect(service.inspectActivity!('owner').active).toBe(true)
      recovered = true
    }
    const receipt = outcome === 'failed' ? await service.awaitDeliveryStop('owner') : await stopping
    if (outcome === 'acknowledged') {
      expect(await joined).toEqual(receipt)
      await drainEntered.promise
      // The close is acknowledged while the pass triggered by that committed
      // generation still owns work. It must keep the session active until done.
      expect(service.inspectActivity!('owner').active).toBe(true)
      releaseDrain.resolve()
    }
    expect(receipt).toMatchObject({ fenceId: expect.any(String) })
    await vi.waitFor(() => expect(service.inspectActivity!('owner').active).toBe(false))
    expect(settlementCalls).toBe(outcome === 'failed' ? 2 : 1)
    const closes = assembly.session.events.filter(event => event.type === 'agent/delivery-generation' && event.op === 'close')
    expect(closes).toHaveLength(1)
    expect(await service.awaitDeliveryStop('owner')).toEqual(receipt)
    expect(assembly.session.events.filter(event => event.type === 'agent/delivery-generation' && event.op === 'close')).toEqual(closes)
    expect(service.inspectActivity!('owner').active).toBe(false)
    if (outcome === 'acknowledged') expect(drainCalls).toBe(1)
  } finally {
    recovered = true; release.resolve()
    releaseDrain.resolve()
    await service.awaitDeliveryStop('owner').catch(() => {})
    await service.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-stop-activity-')) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
