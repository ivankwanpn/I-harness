import type { BigIntStats } from 'node:fs'

export const usableGeneration = (stat: BigIntStats) => stat.isFile() && stat.ino > 0n && stat.mtimeNs > 0n && stat.ctimeNs > 0n
  && (stat.mtimeNs % 1_000_000n !== 0n || stat.ctimeNs % 1_000_000n !== 0n)
export const sameCommitGenerationVersion = (a: BigIntStats, b: BigIntStats) => usableGeneration(a) && usableGeneration(b) && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.birthtimeNs === b.birthtimeNs && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
