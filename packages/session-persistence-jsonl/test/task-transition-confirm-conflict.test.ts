import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', opens: 0, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target) fault.opens++
    if (String(args[0]) === fault.target && args[1] === 'r+') {
      const sync = handle.sync.bind(handle); handle.sync = async () => { fault.entered?.(); await fault.gate; await sync() }
    }
    return handle
  } }
})

it('rejects a future parent before opening its task sidecar',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'future-preflight-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const path=join(root,'p.jsonl'),header=JSON.parse((await readFile(path,'utf8')).trim());header.formatVersion=15;await writeFile(path,JSON.stringify(header)+'\n')
 const task=join(root,'task-p.doc.jsonl'),literal='{"formatVersion":2,"tasks":[],"notifications":[]}\n';await writeFile(task,literal)
 const before=await readFile(path),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract);fault.target=task;fault.opens=0
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(fault.opens).toBe(0);expect(await readFile(path)).toEqual(before);expect(await readFile(task,'utf8')).toBe(literal)}finally{fault.target='';await coordinator.close();await rm(root,{recursive:true,force:true})}
})
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('refuses equal task JSON with changed original bytes during confirmation', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-drift-'))
  await copyFile(join(import.meta.dirname,'fixtures/original13-empty.jsonl'),join(root,'p.jsonl'))
  const path = join(root, 'task-p.doc.jsonl'); await writeFile(path, '{"formatVersion":2,"tasks":[],"notifications":[]}\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.target = path; fault.gate = gate.promise; fault.entered = entered.resolve
  const load = coordinator.loadOwned('p'); void load.catch(() => {})
  try {
    await entered.promise; await writeFile(path, '{ "formatVersion": 2, "tasks": [], "notifications": [] }\n'); gate.resolve()
    await expect(load).rejects.toThrow(); expect(await readFile(path, 'utf8')).toContain('{ "formatVersion"')
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await load.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('confirms the exact physical14 task bytes before repairing the parent', async () => {
  const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-transition-drift14-')),backend=createJsonlBackend(root)
  await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}])
  const parent=await readFile(join(root,'p.jsonl')),path=join(root,'task-p.doc.jsonl');await writeFile(path,'{"formatVersion":2,"tasks":[],"notifications":[]}\n')
  const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
  fault.target=path;fault.gate=gate.promise;fault.entered=entered.resolve;const load=coordinator.loadOwned('p');void load.catch(()=>{})
  try{await entered.promise;await writeFile(path,'{ "formatVersion": 2, "tasks": [], "notifications": [] }\n');gate.resolve();await expect(load).rejects.toThrow();expect(await readFile(join(root,'p.jsonl'))).toEqual(parent)}
  finally{gate.resolve();fault.target='';fault.gate=undefined;fault.entered=undefined;await load.catch(()=>{});await coordinator.close();await rm(root,{recursive:true,force:true})}
})
