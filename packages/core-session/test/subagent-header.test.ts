import { expect, it } from 'vitest'
import { createSession, fromJSONL, toJSONL, migrate, validateSubagentHeader } from '../src/index.ts'

it('preserves the ordinary creation marker through public JSONL and never mints it during a literal9 upgrade', () => {
  const current = createSession()
  current.header = { origin: 'subagent', parentSession: 'parent', seedLength: 0, subagentProtocolVersion: 1 }
  expect(fromJSONL(toJSONL(current)).header).toMatchObject({ subagentProtocolVersion: 1, parentSession: 'parent', origin: 'subagent' })
  const legacy = { ...current, formatVersion: 9, header: { origin: 'subagent', parentSession: 'parent', seedLength: 0 } }
  expect(fromJSONL(toJSONL(legacy)).header).not.toHaveProperty('subagentProtocolVersion')
  expect(migrate(legacy, 10).header).not.toHaveProperty('subagentProtocolVersion')
})

it('rejects unsupported or accessor markers without certifying the header', () => {
  for (const value of [0, 2, '1', null]) {
    const session = createSession()
    session.header = { origin: 'subagent', subagentProtocolVersion: value } as any
    expect(() => toJSONL(session)).toThrow(/protocol/)
  }
  let reads = 0
  const header = { origin: 'subagent' }
  Object.defineProperty(header, 'subagentProtocolVersion', { enumerable: true, get() { reads++; return 1 } })
  expect(() => validateSubagentHeader(header)).toThrow(/protocol/)
  expect(reads).toBe(0)
})
