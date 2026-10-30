import { expect, it } from 'vitest'
import { validateBridgePath } from '../src/native-wait-bridge.ts'

it('rejects relative paths and unsupported architectures before loading a bridge', () => {
  expect(() => validateBridgePath('bridge.dll', 'win32', 'x64')).toThrow(/absolute/)
  expect(() => validateBridgePath('C:\\owned\\bridge.dll', 'win32', 'arm64')).toThrow(/x64/)
  expect(() => validateBridgePath('C:\\owned\\bridge.dll', 'linux', 'x64')).toThrow(/Windows/)
})
