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

/**
 * Creation-time lineage completeness.
 *
 * A parent link only means something together with the number of inherited seed
 * records: the durable history reader refuses a header that names
 * `parentSession` without `seedLength` (JSONL process-read lineage guard), so a
 * writer must reject that header before an unreadable artifact exists.
 */
export function validateLineageHeader(header: object | undefined): void {
  if (!header) return
  const parent = Object.getOwnPropertyDescriptor(header, 'parentSession')
  if (!parent) return
  if (!('value' in parent) || !parent.enumerable || typeof parent.value !== 'string' || !parent.value) throw new TypeError('Invalid parent session lineage')
  const seed = Object.getOwnPropertyDescriptor(header, 'seedLength')
  if (!seed || !('value' in seed) || !seed.enumerable || !Number.isSafeInteger(seed.value) || (seed.value as number) < 0) throw new TypeError('Invalid parent session lineage: a seed length is required')
}
