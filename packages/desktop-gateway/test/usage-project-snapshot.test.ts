import {expect,it,vi} from 'vitest'
import {mkdtemp,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
it('passively snapshots only original loaded project lineage for main child and auxiliary owners',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'project-snapshot-')),workspace=join(root,'workspace');await mkdir(workspace)
 const coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract),broker=createProjectScopeBroker(coordinator,workspace)
 try{
  // Ordinary owner documents; this tests broker inheritance, not child birth.
  await coordinator.create({sessionId:'parent'});await coordinator.create({sessionId:'child'})
  await broker.configure({id:'p',name:'Project',roots:[workspace],primaryRoot:workspace});await broker.bind('parent','p')
  const getDocument=vi.spyOn(coordinator,'getDocument'),profile=vi.spyOn(coordinator,'profile')
  expect(broker.projectSnapshotFor('parent')).toBe('p');expect(broker.projectSnapshotFor('child')).toBeUndefined();expect(broker.projectSnapshotFor('unavailable-aux')).toBeUndefined()
  expect(getDocument).not.toHaveBeenCalled();expect(profile).not.toHaveBeenCalled()
  await broker.inherit('parent','child');getDocument.mockClear();profile.mockClear()
  expect(broker.projectSnapshotFor('child')).toBe('p');expect(broker.projectSnapshotFor('parent')).toBe('p')
  expect(getDocument).not.toHaveBeenCalled();expect(profile).not.toHaveBeenCalled()
 }finally{await broker.close();await coordinator.close()}
})
