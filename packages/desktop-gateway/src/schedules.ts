import { foldScheduleEvents, scheduleView } from "@i-harness/schedule"
import { createScheduleTools, type ScheduleCreateArgs, type ScheduleCreateOutput } from "@i-harness/schedule/tools"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { readOriginalSchedules } from '../../schedule/src/observation.ts'
import { originalManagedExecutionFor, prepareOriginalManagedRuntime } from '../../session-executor/src/host-managed-execution.ts'

/** The UI manages the selected conversation's existing schedule log. No clock
 * or background worker is started here; the assembly's driver still checks
 * due rules only at Agent step boundaries. */
export function createDesktopSchedules(coordinator: SessionCoordinator, service: SessionService) {
  const idle = (sessionId: string): void => {
    const queue = service.queueState(sessionId)
    if (queue.running || queue.queued > 0) throw new Error("session is busy")
  }

  return {
    async list(sessionId: string) {
      await coordinator.profile(sessionId)
      const execution=originalManagedExecutionFor(service,sessionId)
      if(execution){const observed=readOriginalSchedules({identity:execution.identity,observe:()=>execution.observe()}),now=Date.now(),schedules=observed.snapshot.active.map(record=>scheduleView(record,now));observed.assertCurrent();return {schedules}}
      let session = service.liveSession(sessionId)
      if (!session) {
        if (!coordinator.snapshot) throw new Error("Read-only schedule snapshots unavailable")
        const saved = (await coordinator.snapshot(sessionId)).session
        session = service.liveSession(sessionId) ?? saved
      }
      const folded = foldScheduleEvents(session.events, session.header?.seedLength ?? 0)
      const now = Date.now()
      return { schedules: folded.active.map((record) => scheduleView(record, now)) }
    },
    async create(sessionId: string, command: ScheduleCreateArgs): Promise<ScheduleCreateOutput> {
      await coordinator.profile(sessionId)
      idle(sessionId)
      const runtime=await prepareOriginalManagedRuntime(service,sessionId)
      if(runtime){idle(sessionId);runtime.assertCurrent();const tool=runtime.tools.get('schedule_create');if(!tool)throw Error('Original schedule tool unavailable');const result=await tool.execute(command,{sessionId}) as ScheduleCreateOutput;runtime.assertCurrent();await coordinator.flush(sessionId);runtime.assertCurrent();return result}
      const assembly = await service.assemblyFor(sessionId)
      idle(sessionId)
      const tool = createScheduleTools({ session: assembly.session,metadata:assembly.metadataFacts }).find((entry) => entry.name === "schedule_create")!
      const result = await tool.execute(command, {}) as ScheduleCreateOutput
      await coordinator.flush(sessionId)
      return result
    },
    async delete(sessionId: string, id: string): Promise<{ deleted: string }> {
      await coordinator.profile(sessionId)
      idle(sessionId)
      const runtime=await prepareOriginalManagedRuntime(service,sessionId)
      if(runtime){idle(sessionId);runtime.assertCurrent();const tool=runtime.tools.get('schedule_delete');if(!tool)throw Error('Original schedule tool unavailable');const result=await tool.execute({id},{sessionId}) as {deleted:string};runtime.assertCurrent();await coordinator.flush(sessionId);runtime.assertCurrent();return result}
      const assembly = await service.assemblyFor(sessionId)
      idle(sessionId)
      const tool = createScheduleTools({ session: assembly.session,metadata:assembly.metadataFacts }).find((entry) => entry.name === "schedule_delete")!
      const result = await tool.execute({ id }, {}) as { deleted: string }
      await coordinator.flush(sessionId)
      return result
    },
  }
}
