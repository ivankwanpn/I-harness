import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as coreSession from '@i-harness/core-session'
import { append, committedFactSeqs, createSession, projectConversation, renderConversation } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createRuntimeContext } from '../src/index.ts'

describe('current context ownership', () => {
  it('deduplicates adjacent identical observations on the same pending memory source', async () => {
    const session = createSession(), service = createRuntimeContext(session)
    service.registerSection('instructions', () => 'same')
    await Promise.all([service.render(), service.render()])
    expect(session.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
  })
  it('reconciles actual host sections after a rewind restores an older floor', async () => {
    const session = createSession(), service = createRuntimeContext(session)
    let text = 'old rule'
    service.registerSection('instructions', () => text)
    await service.render()
    text = 'actual host rule'
    await service.render()
    append(session, { type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 1, mode: 'conversation', fileOps: [] })
    expect(projectConversation(session).current?.sections[0]?.text).toBe('old rule')
    await service.render()
    expect(projectConversation(session).current?.sections[0]?.text).toBe('actual host rule')
    expect(session.events.filter(event => event.type === 'runtime/context')).toHaveLength(3)
  })

  it('keeps current rules outside completed exchanges and renders only the latest complete snapshot', async () => {
    const session = createSession(), service = createRuntimeContext(session)
    let text = 'rule one'
    service.registerSection('instructions', () => text)
    append(session, { type: 'step/start' })
    await service.render()
    append(session, { type: 'assistant/message', text: 'completed answer' })
    append(session, { type: 'step/end' })
    text = 'rule two'
    await service.render()
    const projection = projectConversation(session)
    expect(renderConversation(projection).map(message => message.content)).toEqual(['## instructions\n\nrule two', 'completed answer'])
    expect(renderConversation({ items: projection.items }).map(message => message.content)).toEqual(['completed answer'])
    expect(projection.items.flatMap(item => item.sources).some(source => source.part === 'runtime-context')).toBe(false)
  })

  it('uses the installed owner floor for a no-op, rewind, republication and explicit clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-runtime-current-'))
    const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
    const { id } = await coordinator.create()
    const document = await coordinator.openManagedDocument(id)
    const source = (signal?: AbortSignal) => document.beginAction(signal)
    const service = createRuntimeContext(document.view, source, id)
    const unrelated = createRuntimeContext(document.view, source, 'different-document')
    const fullReplay = vi.spyOn(coreSession, 'projectCurrentContext')
    try {
      let text = 'old rule'
      service.registerSection('instructions', () => text)
      await service.render()
      text = 'actual host rule'
      await service.render()
      await service.render()
      const records = () => document.view.events.filter(event => event.type === 'runtime/context')
      expect(records()).toHaveLength(2)

      const action = document.beginAction()
      const settlement = action.registerSettlementSource(async () => {})
      try {
        committedFactSeqs(await settlement.rewind.capture({
          type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: records()[1]!.seq!, mode: 'conversation', fileOps: [],
        }).admit())
      } finally {
        await settlement.close()
        action.finish()
      }
      expect(projectConversation(document.view).current?.sections[0]?.text).toBe('old rule')
      await service.render()
      expect(projectConversation(document.view).current?.sections[0]?.text).toBe('actual host rule')
      text = ''
      await service.render()
      await service.render()
      expect(records().map(event => event.sections.map(section => section.text)))
        .toEqual([['old rule'], ['actual host rule'], ['actual host rule'], []])
      expect(fullReplay).not.toHaveBeenCalled()
      await unrelated.render()
      expect(fullReplay).toHaveBeenCalledOnce()
      expect(records()).toHaveLength(4)
    } finally {
      fullReplay.mockRestore()
      await unrelated.close()
      await service.close()
      await coordinator.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
