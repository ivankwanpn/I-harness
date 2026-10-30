import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { verifyWaitAssets } from '../packages/sandbox-windows-acl/src/native-wait-assets.mjs'
export { verifyWaitAssets as verifyAclWaitAssets }
export function verifyAclWaitSourceAssets(packageRoot) {
  const verified = verifyWaitAssets(join(packageRoot, 'native/runtime'))
  for (const [name, relative] of [['acl-wait-bridge.c', 'native/acl-wait-bridge.c'], ['native-wait-worker.mjs', 'src/native-wait-worker.mjs'], ['native-wait-protocol.mjs', 'src/native-wait-protocol.mjs']]) {
    const hash = createHash('sha256').update(readFileSync(join(packageRoot, relative))).digest('hex')
    if (hash !== verified.manifest.files[name]) throw new Error(`ACL generated asset source drift: ${name}`)
  }
  return verified
}
export function copyAclWaitAssets(source, destination) {
  const { manifest } = verifyWaitAssets(source)
  mkdirSync(destination, { recursive: true })
  for (const name of [...Object.keys(manifest.files), 'acl-wait-assets.json']) copyFileSync(join(source, name), join(destination, name))
  verifyWaitAssets(destination)
}
