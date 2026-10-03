import { expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Scheduling seam only: the fd/open/read stay real. A path change is injected
// after fstat and before the first read to make the race deterministic.
const schedule = vi.hoisted(() => ({ afterStat: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args)
    return { stat: async () => { const result = await file.stat(); schedule.afterStat?.(); schedule.afterStat = undefined; return result }, read: file.read.bind(file), close: file.close.bind(file) }
  } }
})
import { readBoundedFile } from '../src/reader.mjs'

it('reads the opened descriptor when the original pathname is replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fd-replace-')), target = join(root, 'source.txt'), chunks:Buffer[]=[]
  writeFileSync(target, 'original\n')
  schedule.afterStat = () => { renameSync(target, join(root, 'old.txt')); writeFileSync(target, 'replacement\n') }
  try {
    const read = await readBoundedFile(target,1024*1024,(b)=>{chunks.push(b)})
    expect(Buffer.concat(chunks).toString()).toBe('original\n')
    expect(read).toMatchObject({ inputBytes:9,eof:true })
  } finally { schedule.afterStat = undefined; rmSync(root, { recursive: true, force: true }) }
})

it('bounds actual file growth beyond the earlier stat without an over-budget probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fd-growth-')), target = join(root, 'source.txt'), chunks:Buffer[]=[]
  writeFileSync(target, 'tiny')
  schedule.afterStat = () => writeFileSync(target, '0123456789abcdefghij')
  try {
    const read=await readBoundedFile(target,10,(b)=>{chunks.push(b)})
    expect(Buffer.concat(chunks).toString()).toBe('0123456789')
    expect(read).toMatchObject({inputBytes:10,eof:false})
  } finally { schedule.afterStat = undefined; rmSync(root, { recursive: true, force: true }) }
})
