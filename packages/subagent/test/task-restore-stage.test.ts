import { expect, it } from 'vitest'
import { TaskRecords } from '../src/task/records.ts'
import { TaskNotifications } from '../src/task/notifications.ts'
const row = {id:'task-1',parentSessionId:'p',toolCallId:'call',childSessionId:'child',agentPath:'a',description:'d',prompt:'p',agent:'a',delivery:'tool' as const,status:'accepted' as const,timeCreated:1}
it('rejects duplicate restored identity and child indexes and unsafe task counters', () => {
  for (const other of [{...row,id:'task-2'}, {...row,id:'task-2',toolCallId:'other'}]) {
    const records=new TaskRecords(); records.seedRestoredCounter([row,other]); records.insertRestored(row); records.indexRestored(row,0)
    expect(() => {records.checkRestoredId(other.id); records.insertRestored(other); records.indexRestored(other,0,true)}).toThrow()
  }
  expect(() => new TaskRecords().seedRestoredCounter([{...row,id:'task-9007199254740991'}],true)).toThrow()
})
it('rejects duplicate notification IDs and unsafe counter', () => {
  const row = {id:'notif-1',submissionId:'t',parentSessionId:'p',messageId:'m',state:'completed' as const,description:'',text:'',status:'pending' as const,attempts:0,timeCreated:1}
  expect(()=>new TaskNotifications().restore([row,row],true)).toThrow()
  expect(()=>new TaskNotifications().restore([{...row,id:'notif-9007199254740991'}],true)).toThrow()
})
it('stages frozen rows without mutating the observation and fails the entire candidate', async () => {
  const { stageTaskRestore } = await import('../src/task/restore-stage.ts')
  const source = Object.freeze({formatVersion:1 as const,tasks:Object.freeze([Object.freeze({...row})]),notifications:Object.freeze([])})
  const stage=stageTaskRestore(source as never, false, false)
  expect(stage.records.get('task-1')).toMatchObject({bodyKind:'legacy-text',legacyFormatVersion:1}); expect(source.tasks[0]).not.toHaveProperty('legacyFormatVersion')
  expect(()=>stageTaskRestore({formatVersion:1,tasks:[row,{...row,id:'task-2'}],notifications:[]},false,false)).toThrow()
})
it('detached v2 projection leaves the frozen source unchanged', async () => {
  const {stageTaskRestore}=await import('../src/task/restore-stage.ts')
  const source=Object.freeze({formatVersion:2 as const,tasks:Object.freeze([Object.freeze({...row})]),notifications:Object.freeze([])})
  const stage=stageTaskRestore(source as never,false,false)
  expect(stage.records.get('task-1')).toMatchObject({status:'recovery-required',publication:'unqualified',savedObservation:{status:'accepted'}})
  expect(source.tasks[0]).toMatchObject({status:'accepted'}); expect(source.tasks[0]).not.toHaveProperty('publication')
})
