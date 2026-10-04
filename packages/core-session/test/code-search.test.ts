import { describe, expect, it } from 'vitest'
import { append, createSession, deriveSearchText, fromJSONL, toJSONL } from '../src/index.ts'

describe('Code Mode searchable event projection', () => {
  it('indexes actual nested call names, arguments and results after durable replay', () => {
    const session = createSession()
    append(session, { type: 'code/call', cellId: 'cell', callId: 'nested', name: 'read', args: { path: 'src/auth.ts' } })
    append(session, { type: 'code/result', cellId: 'cell', callId: 'nested', name: 'read', output: { content: 'approveDeployment checks the current policy' } })
    const replay = fromJSONL(toJSONL(session))
    expect(deriveSearchText(replay.events[0]!)).toContain('read')
    expect(deriveSearchText(replay.events[0]!)).toContain('src/auth.ts')
    expect(deriveSearchText(replay.events[1]!)).toContain('approveDeployment')
  })

  it('indexes emitted text while excluding image and audio transport payloads', () => {
    const session = createSession()
    const payload = 'sensitive_binary_payload'.repeat(100)
    append(session, { type: 'code/output', cellId: 'cell', content: { type: 'text', text: '中段錯誤：核準失敗' } })
    append(session, { type: 'code/output', cellId: 'cell', content: { type: 'image', image: { mediaType: 'image/png', dataBase64: payload } } })
    append(session, { type: 'code/output', cellId: 'cell', content: { type: 'audio', audioUrl: payload } })
    expect(deriveSearchText(session.events[0]!)).toContain('中段錯誤')
    expect(deriveSearchText(session.events[1]!)).toBe('')
    expect(deriveSearchText(session.events[2]!)).toBe('')
    append(session, { type: 'code/result', cellId: 'cell', callId: 'nested', name: 'read_image', output: { description: 'diagram inspected', images: [{ mediaType: 'image/png', dataBase64: payload }] } })
    const indexed = deriveSearchText(session.events[3]!)
    expect(indexed).toContain('diagram inspected')
    expect(indexed).not.toContain(payload)
    append(session, { type: 'code/result', cellId: 'cell', callId: 'mcp', name: 'screenshot', output: { content: [{ type: 'text', text: 'button located' }, { type: 'image', data: payload, mimeType: 'image/png' }] } })
    expect(deriveSearchText(session.events[4]!)).toContain('button located')
    expect(deriveSearchText(session.events[4]!)).not.toContain(payload)
    append(session,{type:'code/call',cellId:'cell',callId:'image-input',name:'inspect_image',args:{prompt:'inspect this diagram',image:{dataBase64:payload}}})
    expect(deriveSearchText(session.events[5]!)).toContain('inspect this diagram')
    expect(deriveSearchText(session.events[5]!)).not.toContain(payload)
  })
})
