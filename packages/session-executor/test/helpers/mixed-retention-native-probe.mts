import fs, { type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { resolve, basename, sep } from 'node:path'
import { total, inventory } from './mixed-retention-fixture.mts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ContextStore } from '../../../context-output/src/store.ts'

/** Real asynchronous syscall boundaries only; SQLite's synchronous work is untouched. */
export async function mixedAdmissionProbe(root: string, onBody: (path: string, native: () => Promise<unknown>) => Promise<unknown>) {
  const original = { open: fs.open, stat: fs.stat, lstat: fs.lstat, writeFile: fs.writeFile, diskBytes: ContextStore.prototype.diskBytes }
  const legacyInventory = new AsyncLocalStorage<true>()
  const handles = new WeakMap<FileHandle,string>()
  const handle = await original.open(resolve(process.env.IH_CONFIG_DIR!,'mixed-native-probe'),'w+')
  const prototype = Object.getPrototypeOf(handle) as FileHandle, nativeWrite = prototype.write
  await handle.close()
  const events: { kind: string; path: string; bytes?: number; physicalBytes?: number }[] = []
  // Delegate the actual caller and return its exact original promise. Both
  // owners use physicalBytes/lstat; this context identifies legacy admission
  // without introducing an accounting call, await or synthetic native event.
  ContextStore.prototype.diskBytes = function (...args) { return legacyInventory.run(true, () => original.diskBytes.apply(this, args)) }
  const owned = (path: unknown) => { const target=resolve(String(path));return target===root||target.startsWith(root+sep) }
  fs.open = (async (...args: Parameters<typeof fs.open>) => { const actual=await original.open(...args); handles.set(actual,resolve(String(args[0]))); return actual }) as typeof fs.open
  fs.stat = (async (...args: Parameters<typeof fs.stat>) => { const info=await original.stat(...args); if(owned(args[0])) events.push({kind:'legacy-native-stat',path:String(args[0])}); return info }) as typeof fs.stat
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => { const info=await original.lstat(...args); if(owned(args[0])) events.push({kind:legacyInventory.getStore()?'legacy-native-lstat':'managed-native-lstat',path:String(args[0])}); return info }) as typeof fs.lstat
  fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
    const selected=owned(args[0]) && String(args[0]).includes('blobs')
    if(selected) events.push({kind:'legacy-before-native-blob',path:String(args[0]),physicalBytes:total(await inventory(root))})
    await original.writeFile(...args)
    if(selected) events.push({kind:'legacy-after-native-blob',path:String(args[0]),physicalBytes:total(await inventory(root))})
  }) as typeof fs.writeFile
  prototype.write = (async function (this: FileHandle, ...args: unknown[]) {
    const path=handles.get(this)
    const invoke=()=>Reflect.apply(nativeWrite,this,args)
    if (!path || !owned(path) || basename(path)!=='body') return invoke()
    events.push({kind:'managed-before-native-body',path,physicalBytes:total(await inventory(root))})
    const result=await onBody(path,invoke)
    events.push({kind:'managed-after-native-body',path,physicalBytes:total(await inventory(root))})
    return result
  }) as typeof prototype.write
  syncBuiltinESMExports()
  return { events, restore() { fs.open=original.open;fs.stat=original.stat;fs.lstat=original.lstat;fs.writeFile=original.writeFile;prototype.write=nativeWrite;ContextStore.prototype.diskBytes=original.diskBytes;syncBuiltinESMExports() } }
}
