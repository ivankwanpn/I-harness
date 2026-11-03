import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContextOutputService } from '../../src/index.ts'
import { ContextStore } from '../../src/store.ts'
import { LegacyIndexLifecycle } from '../../src/legacy/index-lifecycle.ts'
import type { ContextResultRef } from '../../src/types.ts'

const [root, phase] = process.argv.slice(2)
if (!root || !phase) throw Error('Actual lifecycle child requires root and phase')
const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true, maxDiskBytes: 128 * 1024 } })
const seed = await service.capture({ sessionId: 's', callId: 'seed', label: 'seed', text: 'seed needle', complete: true })
if (!seed) throw Error('Actual child seed refused')
await service.configure({ maxDiskBytes: await new ContextStore(root, 'w').diskBytes() + 128 * 1024 })
let prospective: ContextResultRef | undefined
function cut(): never {
  writeFileSync(resolve(root!, 'child-receipt.json'), JSON.stringify({ phase, seed, prospective, node: process.version, sqlite: process.versions.sqlite }))
  // Abrupt process exit while the real owned transaction/lease is live. Cold
  // verification uses a new service; this child never fakes a close result.
  process.exit(31)
}
const begin = LegacyIndexLifecycle.prototype.beginCaptureReplacement
LegacyIndexLifecycle.prototype.beginCaptureReplacement = async function(...args) {
  prospective = args[5].ref
  const pending = await begin.apply(this, args)
  if (phase === 'index-only') cut()
  return pending
}
const exec = DatabaseSync.prototype.exec
DatabaseSync.prototype.exec = function(sql: string) {
  if (prospective && sql === 'COMMIT' && phase === 'canonical-before-index') cut()
  const result = exec.call(this, sql)
  if (prospective && sql === 'COMMIT' && phase === 'committed-unpublished') cut()
  return result
}
await service.capture({ sessionId: 's', callId: 'prospective', label: 'prospective', text: 'prospective needle', complete: true })
throw Error('Actual child did not reach requested crash boundary')
