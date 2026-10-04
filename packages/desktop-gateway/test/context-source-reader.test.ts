import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createNativeCodeSourceReader } from '../src/context-source-reader.ts'

const fixtures: string[] = []
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, {recursive:true,force:true}) })
async function fixture() {
  const base = resolve('build/native-context-reader-tests'); await mkdir(base,{recursive:true})
  const root = await mkdtemp(join(base,'fixture-')); fixtures.push(root)
  return root
}
const config = {enabled:true,mode:'lexical' as const,autoRefresh:false,maxFiles:20000,maxFileBytes:1024*1024,maxInputBytes:128*1024*1024,maxChunks:50000,maxDiskBytes:512*1024*1024,maxSearchBytes:16384,deadlineMs:60000,ignorePatterns:[]}

describe('native Code Context admitted source reader', () => {
  it('honors ignore rules and indexes an external source without writing to it', async () => {
    const root = await fixture(), external = await fixture()
    await writeFile(join(root,'.gitignore'),'ignored.ts\n')
    await writeFile(join(root,'ignored.ts'),'secret source')
    await writeFile(join(root,'main.ts'),'export function approveDeployment() { return true }')
    await writeFile(join(external,'参考.ts'),'export const 核準 = true')
    const before = await readdir(external)
    const reader = createNativeCodeSourceReader({workspace:root,references:()=>[{id:'ref',path:external,label:'reference'}],authorize:async session=>session==='allowed'})
    const snapshots = []
    for await (const snapshot of reader.snapshots({sessionId:'allowed'},{config})) snapshots.push(snapshot)
    expect(snapshots.map(file=>file.path).sort()).toEqual(['main.ts','参考.ts'])
    expect(snapshots.find(file=>file.path==='参考.ts')?.sourceId).toBe('ref')
    expect(await readdir(external)).toEqual(before)
    expect(await readFile(join(external,'参考.ts'),'utf8')).toBe('export const 核準 = true')
    const first = snapshots.find(file=>file.path==='main.ts')!
    const hit = {...first,generation:1,startLine:1,endLine:1,startOffset:0,endOffset:first.text.length,score:1}
    expect(await reader.revalidate({sessionId:'allowed'},hit)).toBe(true)
    await writeFile(join(root,'.gitignore'),'ignored.ts\nmain.ts\n')
    expect(await reader.revalidate({sessionId:'allowed'},hit)).toBe(false)
    await writeFile(join(root,'.gitignore'),'ignored.ts\n')
    await writeFile(join(root,'main.ts'),'changed')
    expect(await reader.revalidate({sessionId:'allowed'},hit)).toBe(false)
    expect(await reader.revalidate({sessionId:'denied'},hit)).toBe(false)
  })

  it('refuses unknown sources and revokes removed reference visibility', async () => {
    const root=await fixture(), external=await fixture(); await writeFile(join(external,'index.ts'),'reference')
    let references = [{id:'ref',path:external,label:'reference'}]
    const reader=createNativeCodeSourceReader({workspace:root,references:()=>references,authorize:async()=>true})
    const snapshots=[]; for await(const snapshot of reader.snapshots({sessionId:'s'},{sourceIds:['ref'],config})) snapshots.push(snapshot)
    expect(snapshots).toHaveLength(1)
    const first=snapshots[0]!, hit={...first,generation:1,startLine:1,endLine:1,startOffset:0,endOffset:first.text.length,score:1}
    references=[]
    expect(await reader.revalidate({sessionId:'s'},hit)).toBe(false)
    await expect((async()=>{for await(const file of reader.snapshots({sessionId:'s'},{sourceIds:['unknown'],config})) void file})()).rejects.toThrow()
  })
})
