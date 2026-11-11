import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'
import { createExecutionGenerationLifecycle as hostLifecycle, assertExecutionGeneration as hostAssert } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { receivedExecutionInputsFor as hostInputs } from '../../session-executor/src/lifecycle/execution-inputs.ts'
import { assertExecutionGeneration } from '../src/lifecycle/generation-actions.ts'
import { receivedExecutionInputsFor } from '../src/lifecycle/execution-inputs.ts'
import { OwnedGenerationAction } from '../src/lifecycle/generation-action.ts'

it('shares original owner state and nominal generation proof across the host compatibility and agent entrypoints', async () => {
  const evidenceRoot = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!
  const root = await mkdtemp(join(evidenceRoot, 'lifecycle-ownership-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), execution = await acquireManagedExecution(coordinator, id)
  const action = execution.owner.beginAction(), inputs = hostInputs(execution), lifecycle = hostLifecycle(execution, id, action)
  let generation: Awaited<ReturnType<typeof lifecycle.open>> | undefined
  try {
    expect(receivedExecutionInputsFor(execution)).toBe(inputs)
    await inputs.inbox.admit({ inputId: 'original', text: 'work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
    const input = await execution.observe().inbox.admitted('original')
    generation = await lifecycle.open('main', { kind: 'input', seq: input!.seq! })
    expect(Object.getPrototypeOf(generation)).toBe(OwnedGenerationAction.prototype)
    expect(() => assertExecutionGeneration(execution, generation!, action)).not.toThrow()
    expect(() => hostAssert(execution, generation!, action)).not.toThrow()
    const copied = Object.create(Object.getPrototypeOf(generation), Object.getOwnPropertyDescriptors(generation))
    expect(() => assertExecutionGeneration(execution, copied, action)).toThrow()
    expect(() => hostAssert(execution, copied, action)).toThrow()
    await generation.close('stopped'); await lifecycle.drain()
    expect(execution.observe().generations()[0]?.closed).toBe('stopped')
  } finally {
    await generation?.close('failed'); await lifecycle.drain(); await inputs.close(); action.finish(); await coordinator.close()
    const tail = relative(evidenceRoot, root)
    if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
