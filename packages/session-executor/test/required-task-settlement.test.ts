import { expect, it } from 'vitest'
import { createDeliveryFixture } from './helpers/required-task-delivery-fixture.ts'

it('drives the original active legacy child Task acknowledgment before required end after parent retirement', async () => {
 const f=await createDeliveryFixture()
 try {
  await f.start()
  expect(f.launchCount()).toBe(1)
  const closing=f.service.close();void closing.catch(()=>{})
  // Service close synchronously fences new parent work before joining its child.
  f.releaseChild()
  await closing
  const events=(await f.backend.read('parent')).events
  expect(events.filter(event=>event.type==='agent/delivery-source')).toHaveLength(1)
  expect(events.filter(event=>event.type==='subagent/end')).toHaveLength(1)
  expect(f.launchCount()).toBe(1)
 } catch(cause) {console.info('required-legacy-primary',cause);throw cause} finally {f.releaseChild();await f.close()}
},20000)
