import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyWaitAssets } from '../src/native-wait-assets.mjs'

it('requires exact hash inventory, fixed Worker and original ABI without loading a DLL', async () => {
  const evidence = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!evidence) throw new Error('run with assigned six-root runner')
  const root = mkdtempSync(join(evidence, 'wait-assets-'))
  const files: Record<string, string> = {}
  for (const name of ['ih-acl-wait-bridge.dll', 'native-wait-worker.mjs', 'native-wait-protocol.mjs', 'acl-wait-bridge.c']) {
    // Deliberately not a native image: this test checks metadata/hash policy only.
    const bytes = Buffer.from(`fixture:${name}`)
    writeFileSync(join(root, name), bytes)
    files[name] = createHash('sha256').update(bytes).digest('hex')
  }
  const manifest = { protocol: 1, platform: 'win32', arch: 'x64', koffiVersion: '3.1.6', export: 'ih_acl_unregister_wait_and_drain', abi: { return: 'DWORD', arguments: ['HANDLE'], convention: 'WINAPI' }, build: { compiler: 'MSVC14.41.34120', sdk: '10.0.22621.0' }, files }
  const save = () => writeFileSync(join(root, 'acl-wait-assets.json'), JSON.stringify(manifest))
  save()
  expect(verifyWaitAssets(root).workerPath).toBe(join(root, 'native-wait-worker.mjs'))
  const packaging = await import(new URL('../../../scripts/runtime-acl-wait-assets.mjs', import.meta.url).href)
  const copy = mkdtempSync(join(evidence, 'wait-assets-copy-'))
  packaging.copyAclWaitAssets(root, copy)
  expect(verifyWaitAssets(copy).manifest.files).toEqual(files)
  manifest.abi.return = 'BOOL'; save()
  expect(() => verifyWaitAssets(root)).toThrow(/ABI/)
  manifest.abi.return = 'DWORD'; save()
  writeFileSync(join(root, 'native-wait-worker.mjs'), 'changed')
  expect(() => verifyWaitAssets(root)).toThrow(/hash mismatch/)
})
