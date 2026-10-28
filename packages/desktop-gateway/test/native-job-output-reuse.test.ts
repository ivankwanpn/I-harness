import { expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createDurableSessionLoader, createSessionService } from '@i-harness/session-executor'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'

it('binds native continuation to the original service instance even when ids, source and stdout bytes repeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'j3-reuse-')), coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' })
  const script = join(root, 'small.cjs'), release = join(root, 'release')
  await writeFile(script, 'process.stdout.write("QA_JOB_OUTPUT\\n");const timer=setInterval(()=>{if(require("node:fs").existsSync(process.argv[2]))clearInterval(timer)},10)')
  const make = () => createSessionService({ workspace: root, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  let live = make(), n = 0
  const run = async (name: string, args: Record<string, unknown>) => {
    const assembly = await live.assemblyFor('s'), callId = `reuse-${++n}`, action = assembly.factOwner.beginAction()
    let complete = false
    const source = action.registerSettlementSource(async () => { if (!complete) throw new Error('Original fixture result requires recovery') })
    try {
      const callEventSeq = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId, name, args }))[0]
      const prepared = await assembly.tools.prepare({ name, args }, undefined, { sessionId: 's', session: assembly.session, callId, callEventSeq, settlementSource: source })
      const output = await assembly.tools.dispatch(prepared), result = await assembly.tools.finalize(prepared, output)
      if (!result.envelope || result.program?.kind !== 'value') throw new Error('Expected genuine finalized tool value')
      committedFactSeqs(await source.tools.captureResult({ type: 'tool/result', callId, name, envelope: result.envelope }).admit())
      complete = true; await source.close()
      return { value: result.program.value as any, envelope: result.envelope }
    } finally { action.finish() }
  }
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const command = process.platform === 'win32' ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' '${release.replaceAll("'", "''")}'` : `'${process.execPath}' '${script}' '${release}'`
  try {
    const a = (await run(shell, { command, background: true })).value
    const pending = await run('job_output', { job_id: a.job_id })
    expect(pending.value).toMatchObject({ status: 'running', source: { kind: 'pending' }, display_only: true })
    expect(pending.value.total_bytes).toBeUndefined(); expect(pending.envelope.dependencies).toBeUndefined()
    await writeFile(release, '')
    const original = await run('job_output', { job_id: a.job_id, wait: true, timeout_ms: 5000 })
    expect(original.value).toMatchObject({ text: 'QA_JOB_OUTPUT\n', total_bytes: 14 })
    await coordinator.flush('s'); await live.close()
    await rm(release, { force: true })
    live = make()
    const b = (await run(shell, { command, background: true })).value
    await writeFile(release, '')
    const current = await run('job_output', { job_id: b.job_id, wait: true, timeout_ms: 5000 })
    expect(a.job_id).toBe(b.job_id); expect(a.native_job.sourceId).toBe(b.native_job.sourceId)
    expect(a.native_job.instanceId).not.toBe(b.native_job.instanceId)
    expect(original.value.digest).toBe(current.value.digest)
    expect((await run('job_output', original.value.text_result.args)).value).toMatchObject({ error: { code: 'stale-instance' }, native_job: b.native_job })
    expect((await run('job_output', { job_id: b.job_id, digest: original.value.digest, offset_bytes: 0 })).value).toMatchObject({ error: { code: 'instance-required' } })
    expect((await run('job_output', { ...current.value.text_result.args, offset_bytes: 0 })).value).toMatchObject({ text: 'QA_JOB_OUTPUT\n', total_bytes: 14, native_job: b.native_job })
    const store = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: 's' })
    try {
      if (!store.service || original.envelope.dependencies?.kind !== 'artifact-set') throw new Error('Expected authentic original catalog')
      const page = await store.service.readExecResult({ sessionId: 's' }, { ref: original.value.full_result.args.ref, viaCatalog: original.envelope.dependencies.ref })
      expect(page.eof).toBe(true)
      expect(Buffer.concat(page.frames.filter(f => f.channel === 'stdout').map(f => Buffer.from(f.data, 'base64'))).toString()).toBe('QA_JOB_OUTPUT\n')
    } finally { await store.release() }
  } finally { await writeFile(release, ''); await live.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)
