import fs from 'node:fs/promises'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { tsImport } from 'tsx/esm/api'

const dir = process.env.IH_CONFIG_DIR
const pathToHold = process.env.IH_TEST_CATALOG_PATH
const method = process.env.IH_TEST_CATALOG_OPERATION
if (!dir || !pathToHold || (method !== 'stat' && method !== 'readFile')) throw Error('Missing controlled catalog read')
const read = fs[method].bind(fs)
fs[method] = async (path, ...args) => {
  if (String(path) === pathToHold) {
    await fs.appendFile(join(dir, 'read-started'), 'read\n')
    for (;;) {
      try { await fs.access(join(dir, 'release')); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(20)
    }
  }
  return read(path, ...args)
}
syncBuiltinESMExports()
await tsImport('../../src/main/session-catalog-worker.ts', import.meta.url)
