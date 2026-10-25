import { resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { boundedJson, confirmAtomicJson, ownedPath, type RetireFile } from '../artifact/io.ts'
import { checkPage, recordHash, fail } from './fork-codec.ts'
import type { LegacyBinding, LegacyRow, LegacyPage, LegacyPageRef, LegacyRoot } from './fork-types.ts'

export const pageName = (ref: Pick<LegacyPageRef, 'level' | 'firstRow'>) => `${ref.level}-${ref.firstRow}.json`
/** Only one leaf and a fanout-bounded frontier per level are resident. */
export async function buildPages(binding: LegacyBinding, rows: AsyncIterable<LegacyRow>, publish: (name: string, page: LegacyPage) => Promise<void>): Promise<{ pages: LegacyPageRef | null; observationCount: number }> {
  const bindingDigest = recordHash('binding', binding), frontier: LegacyPageRef[][] = []
  let leaf: LegacyRow[] = [], observationCount = 0, firstRow = 0
  async function directory(level: number, children: LegacyPageRef[]): Promise<LegacyPageRef> {
    const page: LegacyPage = { version: 1, kind: 'legacy-fork-directory', bindingDigest, level, children }
    checkPage(page, binding)
    const ref = { digest: recordHash('page', page), firstRow: children[0]!.firstRow, rows: children.reduce((n, child) => n + child.rows, 0), level }
    await publish(pageName(ref), page); return ref
  }
  async function push(ref: LegacyPageRef): Promise<void> {
    const list = frontier[ref.level] ??= []; list.push(ref)
    if (list.length === 100) { frontier[ref.level] = []; await push(await directory(ref.level + 1, list)) }
  }
  async function flush(): Promise<void> {
    if (!leaf.length) return
    const page: LegacyPage = { version: 1, kind: 'legacy-fork-leaf', bindingDigest, firstRow, rows: leaf }
    checkPage(page, binding)
    await publish(pageName({ level: 0, firstRow }), page)
    await push({ digest: recordHash('page', page), firstRow, rows: leaf.length, level: 0 })
    firstRow += leaf.length; leaf = []
  }
  for await (const row of rows) {
    const tentative = { version: 1, kind: 'legacy-fork-leaf', bindingDigest, firstRow, rows: [...leaf, row] }
    if (leaf.length && (leaf.length === 100 || Buffer.byteLength(JSON.stringify(tentative)) > 65536)) await flush()
    leaf.push(row); observationCount++; if (!Number.isSafeInteger(observationCount)) fail()
  }
  await flush()
  while (true) {
    const low = frontier.findIndex(list => list?.length)
    if (low < 0) return { pages: null, observationCount }
    const list = frontier[low]!
    if (list.length === 1 && !frontier.slice(low + 1).some(list => list?.length)) return { pages: list[0]!, observationCount }
    frontier[low] = []; await push(await directory(low + 1, list))
  }
}
/** Validate the entire addressed graph, ranges and on-disk EOF on every walk. */
export async function* walkPages(directory: string, root: LegacyRoot, guard: () => void, groupCount?: number, retire?: RetireFile, visit?: (ref: LegacyPageRef, page: LegacyPage) => Promise<void>): AsyncGenerator<LegacyRow> {
  let count = 0, files = 0
  const pagesDirectory = resolve(directory, 'pages')
  async function* walk(ref: LegacyPageRef): AsyncGenerator<LegacyRow> {
    guard(); const path = resolve(pagesDirectory, pageName(ref)); await ownedPath(directory, path); guard()
    const page = checkPage(await boundedJson(path, 65536, retire), root.binding, groupCount); guard(); files++
    if ((await confirmAtomicJson(directory, path, page, retire)).kind !== 'confirmed') throw Error('Legacy original page unconfirmed'); guard()
    if (recordHash('page', page) !== ref.digest || ref.firstRow !== count) fail()
    if (page.kind === 'legacy-fork-leaf') {
      if (ref.level !== 0 || page.firstRow !== ref.firstRow || page.rows.length !== ref.rows) fail()
      await visit?.(ref, page); guard()
      for (const row of page.rows) { count++; guard(); yield row }
    } else {
      if (page.level !== ref.level || ref.level > 53 || page.children[0]!.firstRow !== ref.firstRow || page.children.reduce((n, child) => n + child.rows, 0) !== ref.rows) fail()
      await visit?.(ref, page); guard()
      for (const child of page.children) yield* walk(child)
    }
  }
  if (root.pages) yield* walk(root.pages)
  if (count !== root.observationCount) fail()
  guard()
  const entries = await readdir(pagesDirectory); guard()
  // Exact pending siblings are checked by immutable confirmation; any extra
  // final page is a different/incomplete graph rather than silently ignored.
  if (entries.filter(name => name.endsWith('.json')).length !== files) fail()
}

/** A derived row ordinal is only a hint. The actual root and every addressed
 * directory/leaf hash prove the selected row without reconstructing a plan. */
export async function rowProof(directory: string, root: LegacyRoot, ordinal: number, guard: () => void, retire?: RetireFile): Promise<LegacyRow> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= root.observationCount || !root.pages) fail()
  let ref = root.pages
  while (true) {
    guard(); const path = resolve(directory, 'pages', pageName(ref)); await ownedPath(directory, path); guard()
    const page = checkPage(await boundedJson(path, 65536, retire), root.binding); guard()
    if ((await confirmAtomicJson(directory, path, page, retire)).kind !== 'confirmed') throw Error('Legacy original page unconfirmed'); guard()
    if (recordHash('page', page) !== ref.digest || ordinal < ref.firstRow || ordinal >= ref.firstRow + ref.rows) fail()
    if (page.kind === 'legacy-fork-leaf') {
      if (ref.level !== 0 || page.firstRow !== ref.firstRow || page.rows.length !== ref.rows) fail()
      return page.rows[ordinal - page.firstRow]!
    }
    if (page.level !== ref.level || ref.level > 53 || page.children[0]!.firstRow !== ref.firstRow || page.children.reduce((n, child) => n + child.rows, 0) !== ref.rows) fail()
    const child = page.children.find(child => ordinal >= child.firstRow && ordinal < child.firstRow + child.rows)
    if (!child) fail(); ref = child
  }
}
