import { describe, expect, it } from 'vitest'
import { append, createSession, projectConversation, renderConversation } from '@i-harness/core-session'
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
})
