import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fixture, rawBytes } from './native-dependency-fixture.ts'
const { physicalBytes } = await import('../../context-output/src/artifact/quota.ts')

it('preserves a real native growth quota refusal as an ordered unavailable source', async () => {
  const f = await fixture('known-source-refusal')
  const native: unknown[] = []
  let calibration: unknown
  await f.mount(async () => {
    native.push(await f.exec.run({ argv: [process.execPath, '-e', "process.stdout.write('first-complete');process.exitCode=5"] }))
    const physical = await physicalBytes(f.ownedRoot), quota = physical + 210000
    await f.service.configure({ maxDiskBytes: quota })
    native.push(await f.exec.run({ argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(300000,113))'] }))
    calibration = { physical, quota, admissionReserve: 196608, writeGrowthReserve: 131104, inventoryAfterNative: await f.inventory() }
    // This is a genuine configured quota change after the source's immutable
    // refusal, allowing the separate catalog its normal admission reservation.
    await f.service.configure({ maxDiskBytes: 16777216 })
    return { native }
  })
  try {
    await f.assembly.agent.run('retain a known refusal')
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    if (result?.type !== 'tool/result' || result.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected original catalog')
    const catalog = JSON.parse((await rawBytes(f.service, f.id, result.envelope.dependencies.ref)).toString())
    expect(result.envelope.dependencies).toMatchObject({ count: 2, ref: { completeness: 'source-limited' } })
    expect(catalog.entries).toHaveLength(2)
    expect(catalog.entries[0]).toMatchObject({ retention: { kind: 'artifact', ref: { completeness: 'complete' } } })
    expect(catalog.entries[1]).toMatchObject({ retention: { kind: 'unavailable', reason: 'quota' } })
    expect(native).toMatchObject([{ exitCode: 5 }, { exitCode: 0, retentionFailure: 'unavailable' }])
    expect(result.envelope.execution).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    expect((await f.inventory()).some(row => row.operation.codec === 'exec-frames-v1' && row.operation.phase === 'refused' && row.operation.reason === 'quota')).toBe(true)
    await writeFile(resolve(f.root, 'refusal-receipt.json'), JSON.stringify({ calibration, native, catalog, result }, null, 2))
  } finally { await f.close() }
}, 60000)

it('reports the actual positive registered count when catalog admission is refused by quota', async () => {
  const f = await fixture('known-catalog-refusal')
  let calibration: unknown
  await f.mount(async () => {
    const native = []
    for (let n = 0; n < 2; n++) native.push(await f.exec.run({ argv: [process.execPath, '-e', `process.stdout.write('native-${n}')`] }))
    const physical = await physicalBytes(f.ownedRoot), quota = physical + 196607
    await f.service.configure({ maxDiskBytes: quota })
    calibration = { physical, quota, beginReserve: 196608, precedingInventory: await f.inventory() }
    return { nativeExits: native.map(row => row.exitCode) }
  })
  try {
    await f.assembly.agent.run('retain exact catalog refusal count')
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { nativeExits: [0, 0] } }, dependencies: { kind: 'unavailable', reason: 'quota', count: 2 } } })
    expect(await f.inventory()).toHaveLength(2)
    await writeFile(resolve(f.root, 'refusal-receipt.json'), JSON.stringify({ calibration, result }, null, 2))
  } finally { await f.close() }
}, 60000)

it('distinguishes exact interrupted leaf completeness from catalog limitation and complete nonzero execution', async () => {
  const f = await fixture('native-output-limit')
  let native: unknown
  await f.mount(async () => {
    const complete = await f.exec.run({ argv: [process.execPath, '-e', "process.stdout.write('complete-nonzero');process.exitCode=5"] })
    const limited = await f.exec.run({ argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(40000,122));setTimeout(()=>{},3000)'] }, { stream: { maxBytes: 1, onStdout() {} } })
    native = { complete, limited }
    return native
  })
  try {
    await f.assembly.agent.run('compare native capture and execution')
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    if (result?.type !== 'tool/result' || result.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('Expected native catalog')
    const catalog = JSON.parse((await rawBytes(f.service, f.id, result.envelope.dependencies.ref)).toString())
    expect(catalog.entries).toHaveLength(2)
    expect(catalog.entries[0]).toMatchObject({ retention: { kind: 'artifact', ref: { completeness: 'complete' } } })
    expect(catalog.entries[1]).toMatchObject({ retention: { kind: 'artifact', ref: { completeness: 'producer-incomplete' } } })
    expect(result.envelope.dependencies.ref.completeness).toBe('source-limited')
    expect(native).toMatchObject({ complete: { exitCode: 5, timedOut: false }, limited: { stream: { bytesAdmitted: { stdout: 1, stderr: 0 }, stopReason: 'output-limit' }, outputDiagnostics: { discardedOutputBytes: expect.any(Number) } } })
    expect((native as { limited: { outputDiagnostics: { discardedOutputBytes: number } } }).limited.outputDiagnostics.discardedOutputBytes).toBeGreaterThan(0)
    await writeFile(resolve(f.root, 'completeness-receipt.json'), JSON.stringify({ mechanism: 'original ExecService stream.maxBytes=1 -> supervisor output-limit cancellation', native, result, catalog }, null, 2))
  } finally { await f.close() }
}, 60000)
