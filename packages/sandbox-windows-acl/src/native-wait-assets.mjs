import { isAbsolute, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** A ROOT-reviewed generated asset set is required; a stale DLL or runtime build is never a fallback. */
export function verifyWaitAssets(root) {
  if (!isAbsolute(root)) throw new Error('ACL wait asset root must be absolute')
  const manifest = JSON.parse(readFileSync(join(root, 'acl-wait-assets.json'), 'utf8'))
  if (manifest.protocol !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.koffiVersion !== '3.1.6' ||
      manifest.export !== 'ih_acl_unregister_wait_and_drain' || manifest.abi?.return !== 'DWORD' || manifest.abi?.convention !== 'WINAPI' ||
      JSON.stringify(manifest.abi?.arguments) !== '["HANDLE"]' || manifest.build?.compiler !== 'MSVC14.41.34120' || manifest.build?.sdk !== '10.0.22621.0') {
    throw new Error('ACL wait asset ABI/protocol/pin/provenance mismatch')
  }
  const required = ['ih-acl-wait-bridge.dll', 'native-wait-worker.mjs', 'native-wait-protocol.mjs', 'acl-wait-bridge.c']
  if (!manifest.files || Object.keys(manifest.files).sort().join() !== required.sort().join()) throw new Error('ACL wait asset inventory mismatch')
  for (const name of required) {
    const expected = manifest.files[name]
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || createHash('sha256').update(readFileSync(join(root, name))).digest('hex') !== expected) throw new Error(`ACL wait asset hash mismatch: ${name}`)
  }
  return { manifest, workerPath: join(root, 'native-wait-worker.mjs'), bridgePath: join(root, 'ih-acl-wait-bridge.dll') }
}
