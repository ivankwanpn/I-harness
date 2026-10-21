/** Protocol marker is a creation fact, not inherited execution/read authority. */
export function validateSubagentHeader(header: object | undefined): void {
  if (!header) return
  const seed = Object.getOwnPropertyDescriptor(header, 'semanticSeed')
  if (seed) { if (!('value' in seed) || !seed.enumerable) throw new TypeError('Invalid semantic seed header'); validateSeedHeader(seed.value) }
  const marker = Object.getOwnPropertyDescriptor(header, 'subagentProtocolVersion')
  if (!marker) return
  const origin = Object.getOwnPropertyDescriptor(header, 'origin')
  if (!('value' in marker) || !marker.enumerable || marker.value !== 1 || !origin || !('value' in origin) || origin.value !== 'subagent') throw new TypeError('Unsupported subagent header protocol')
}
import { validateSeedHeader } from '../conversation/bootstrap-validation.ts'
