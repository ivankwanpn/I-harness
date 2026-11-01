import type { SeedHeader, SeedManifestEvent } from '../events/bootstrap.ts'
import { seedCount, seedInvalid } from './seed-codec.ts'

/** One physical-coordinate owner. Group ordinals remain logical ordinals. */
export function seedLayout(value: SeedHeader | import('../managed/types.ts').DeepReadonly<SeedManifestEvent>) {
  const pages = value.version === 3 ? value.resultPageCount : 0, groups = value.groupCount
  if (!seedCount(pages) || !seedCount(groups) || !Number.isSafeInteger(1 + pages + groups)) seedInvalid()
  if (value.version === 3 && (value.results.pages !== pages || 'seedLength' in value && value.seedLength !== 1 + pages + groups)) seedInvalid()
  const seedLength = 'seedLength' in value && value.seedLength === 0 && value.version === 1 ? 0 : 1 + pages + groups
  if (value.version === 3 && 'seedLength' in value) {
    const hasInitial = value.initialInputId !== undefined
    if (!Number.isSafeInteger(seedLength) || hasInitial && !Number.isSafeInteger(seedLength + 1)
      || !Number.isSafeInteger(seedLength + 1 + (hasInitial ? 1 : 0))) seedInvalid()
  }
  return { resultPageCount: pages, groupCount: groups, seedLength,
    resultPageSeq(ordinal: number) { if (!seedCount(ordinal) || ordinal >= pages) seedInvalid(); return 1 + ordinal },
    groupSeq(ordinal: number) { if (!seedCount(ordinal) || ordinal >= groups) seedInvalid(); return 1 + pages + ordinal } }
}
