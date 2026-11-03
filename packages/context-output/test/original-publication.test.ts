import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAtomicJsonPublication, pendingPath } from '../src/artifact/io.ts'
const cut = vi.hoisted(() => ({ path: '', mode: '' }))
vi.mock('node:fs/promises', async original => {
 const fs = await original<typeof import('node:fs/promises')>()
 return { ...fs, async open(...args: Parameters<typeof fs.open>) {
  if (String(args[0]) === cut.path && args[1] === 'wx+' && cut.mode === 'before') { cut.mode=''; throw Error('Before original create') }
  const handle = await fs.open(...args)
  if (String(args[0]) === cut.path && args[1] === 'wx+') {
   const stat = handle.stat.bind(handle), close = handle.close.bind(handle)
   handle.stat = (async (...args: Parameters<typeof stat>) => { if (cut.mode === 'stat') { cut.mode=''; throw Error('After original create before identity') }; return stat(...args) }) as typeof handle.stat
   handle.close = async () => { if (cut.mode === 'close') { cut.mode=''; throw Error('Before original handle close') }; await close() }
  }
  const sync=handle.sync.bind(handle)
  handle.sync=async()=>{await sync();if(String(args[0])===cut.path&&cut.mode==='replace'){cut.mode='';const bytes=await fs.readFile(cut.path);await fs.unlink(cut.path);await fs.writeFile(cut.path,bytes)}}
  return handle
 } }
})
afterEach(() => { cut.path='';cut.mode='' })
it.each(['before','stat','close'])('retains the original managed publication through a %s failure', async mode => {
 const root=await mkdtemp(join(tmpdir(),'ih-original-publication-')), path=join(root,'pin.json'), value={version:1,owner:'original'}
 const original=createAtomicJsonPublication(root,path,value);cut.path=pendingPath(path,Buffer.from(JSON.stringify(value)));cut.mode=mode
 expect((await original.issue(()=>true)).kind).not.toBe('confirmed')
 if(mode==='before') { expect((await original.settle(()=>true)).kind).not.toBe('confirmed');expect((await original.issue(()=>true)).kind).toBe('confirmed') }
 else expect((await original.settle(()=>true)).kind).toBe('confirmed')
 expect((await original.confirm()).kind).toBe('confirmed')
})
it('refuses foreign equal finals, pending files and replacement inodes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-original-foreign-')), value={owner:'original'},bytes=Buffer.from(JSON.stringify(value))
 for(const kind of ['final','pending']) {
  const directory=join(root,kind);await mkdir(directory);const path=join(directory,'pin.json'),original=createAtomicJsonPublication(root,path,value)
  await writeFile(kind==='final'?path:pendingPath(path,bytes),bytes)
  expect((await original.issue(()=>true)).kind).not.toBe('confirmed');expect((await original.settle(()=>true)).kind).not.toBe('confirmed')
 }
 const path=join(root,'owned.json'),original=createAtomicJsonPublication(root,path,value);expect((await original.issue(()=>true)).kind).toBe('confirmed')
 await unlink(path);await writeFile(path,bytes);expect((await original.confirm()).kind).toBe('conflict')
})

it('does not replace the native identity after an original publication disappears',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-original-disappeared-')),path=join(root,'pin.json'),original=createAtomicJsonPublication(root,path,{owner:'original'})
 expect((await original.issue(()=>true)).kind).toBe('confirmed');await unlink(path)
 expect((await original.issue(()=>true)).kind).not.toBe('confirmed')
 expect((await original.settle(()=>true)).kind).not.toBe('confirmed')
})

it('rechecks original native identity after the final metadata sync',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-original-sync-swap-')),path=join(root,'pin.json'),original=createAtomicJsonPublication(root,path,{owner:'original'})
 expect((await original.issue(()=>true)).kind).toBe('confirmed');cut.path=path;cut.mode='replace'
 expect((await original.confirm()).kind).toBe('conflict')
})
