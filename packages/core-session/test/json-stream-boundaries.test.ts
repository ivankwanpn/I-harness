import { expect, it } from 'vitest'
import { canonicalJsonData, stringifyJsonData, streamJsonData } from '../src/index.ts'

it.each([0, 1, 4094, 4095, 4096, 4097, 8193])('preserves exact escaping and the existing chunk bound for %i-unit keys and strings', length => {
  for (const unit of ['x', '\u0000', '\n', '\"', '\\', '\ud800', 'é']) {
    const text = unit.repeat(length)
    const source = { [text]: text }
    const expected = JSON.stringify(source)
    const chunks = [...streamJsonData(source)]
    expect(chunks.join('')).toBe(expected)
    expect(stringifyJsonData(source)).toBe(expected)
    expect(canonicalJsonData(source)).toBe(expected)
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 24576)).toBe(true)
  }
})

it('preserves paired and lone surrogates across both short and segmented boundaries', () => {
  for (const prefix of [4093, 4094, 4095, 4096]) {
    const text = 'x'.repeat(prefix) + '🙂' + '\ud800' + 'é'
    const source = { [text]: [text, null, -0] }
    const chunks = [...streamJsonData(source)]
    expect(chunks.join('')).toBe(JSON.stringify(source))
    expect(canonicalJsonData(source)).toBe(JSON.stringify(source))
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 24576)).toBe(true)
  }
})

it('keeps canonical numeric-key order and proto data separate from native enumeration order', () => {
  const value = { '2': '\u0000', '10': '\ud800', z: '🙂', a: '\"' }
  Object.defineProperty(value, '__proto__', { enumerable: true, value: 'original data' })
  const expected = '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + JSON.stringify(Reflect.get(value, key))).join(',') + '}'
  expect(canonicalJsonData(value)).toBe(expected)
  expect(stringifyJsonData(value)).toBe(JSON.stringify(value))
})
