// Real native B2 birth setup has a separate resource envelope; this is not a latency qualification.
const NATIVE_B2_CASE_MS = 60_000
import { expect, it, vi } from 'vitest'
import { backgroundEventForTool } from '@i-harness/core-tools'
import { createDeliveryFixture } from './helpers/delivery-fixture.ts'


// Each real birth gets its own functional resource envelope; consumption below stays four seconds.
async function nativeStartupStage(name:string,work:Promise<void>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native B2 startup stage pending: '+name)),20_000)})])}finally{clearTimeout(timer!)}}

it('genuine B completion yields held foreground A and promotes the original receipt', async () => {
  const f = await createDeliveryFixture({ activeForeground: true })
  const starting = f.start(); void starting.catch(() => {})
  try {
    await nativeStartupStage('first background child actual model',f.waitForChildStarted())
    await nativeStartupStage('second foreground child actual model',f.waitForForeground()); expect(f.launchCount()).toBe(2)
    f.releaseChild(); await Promise.race([f.waitForConsumed(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('receipt not consumed: ' + JSON.stringify(f.parentRequests.length) + ' launches ' + f.launchCount())), 4000))]); await starting
    const events = (await f.backend.read('parent')).events
    expect(events.filter(e => e.type === 'agent/delivery-received')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-'))).toHaveLength(1)
    expect(f.launchCount()).toBe(2)
    const result = events.find(e => e.type === 'tool/result' && e.callId === 'foreground-a')
    expect(result).toMatchObject({ envelope: { retention: { kind: 'inline', value: { task_id: 'task-2', yielded: true, yield_reason: 'background-event' } } } })
    expect(JSON.stringify(result)).not.toContain('original child result')
  } catch (error) { await f.evidence('active-wait-original-diagnostic',error);console.info('active-wait-state', backgroundEventForTool({ session: (await f.service.assemblyFor('parent')).session })?.pending()); console.info('active-wait-failure', error, JSON.stringify((await f.backend.read('parent')).events.filter(e => ['subagent/start','subagent/end','agent/delivery-source','agent/delivery-received','agent/input/admitted','tool/result'].includes(e.type)))); throw error } finally { f.releaseChild(); f.releaseForeground(); await starting.catch(() => {}); try{await vi.waitFor(async () => { const doc = await f.coordinator.getDocument('task-parent') as { notifications: { submissionId: string; status: string }[] }; expect(doc.notifications.find(n => n.submissionId === 'task-2')?.status).toBe('delivered') }, { timeout: 5000 }); await (await f.service.assemblyFor('parent')).drainParentNotifications?.()}catch(error){await f.evidence('active-wait-finalization-failure',error);throw error}finally{await f.close()} }
}, NATIVE_B2_CASE_MS)

it('reserves the original foreground handoff before an unrelated later notification save can hold the queue',async()=>{
 const f=await createDeliveryFixture({activeForeground:true,holdLaterForegroundSave:true}),starting=f.start();void starting.catch(()=>{})
 try{
  await nativeStartupStage('first background child actual model',f.waitForChildStarted());await nativeStartupStage('second foreground child actual model',f.waitForForeground())
  f.releaseChild();await f.waitForLaterForegroundSave()
  let timer:ReturnType<typeof setTimeout>
  await Promise.race([f.waitForForegroundHandoff(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Original handoff waited for a later notification save')),4000)})]).finally(()=>clearTimeout(timer!))
  const events=(await f.backend.read('parent')).events
  expect(events.filter(event=>event.type==='tool/result'&&event.callId==='foreground-a')).toEqual([expect.objectContaining({envelope:expect.objectContaining({retention:expect.objectContaining({kind:'inline',value:expect.objectContaining({task_id:'task-2',yielded:true,yield_reason:'background-event'})})})})])
  expect(events.filter(event=>event.type==='subagent/end'&&event.taskId==='task-2')).toHaveLength(0);expect(f.launchCount()).toBe(2)
  f.releaseLaterForegroundSave();await f.waitForConsumed();await starting
 }finally{f.releaseLaterForegroundSave();f.releaseChild();f.releaseForeground();await starting.catch(()=>{});await f.close()}
},NATIVE_B2_CASE_MS)
