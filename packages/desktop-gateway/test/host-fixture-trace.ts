import type { RpcMessage } from '@i-harness/sdk'

/** Keep a bounded boundary trace for host fixtures. A Vitest timeout otherwise
 * cannot distinguish initialization, prompt/tool execution, and shutdown. */
export function createHostFixtureTrace(label: string) {
  const createdAt = Date.now()
  const stages: Array<{ stage: string; elapsedMs: number; outcome: 'completed'|'failed' }> = []
  type Boundary = { method?: string; event?: string; name?: string; state?: string; id?: string|number }
  const boundaries: Array<Boundary & { elapsedMs: number; gapMs: number }> = []
  let lastFrame: Boundary | undefined, lastFrameAt = createdAt
  const report = (stage: string, startedAt: number, outcome: string) => console.warn(`[host-fixture] ${label}: ${outcome} at ${stage} ${JSON.stringify({elapsedMs:Date.now()-startedAt,lastFrame,lastFrameAgeMs:Date.now()-lastFrameAt,stages,boundaries})}`)
  return {
    observe(frame: RpcMessage) {
      if ('method' in frame) {
        const params = frame.params as { event?: { type?: unknown; name?: unknown; state?: unknown } } | undefined
        const event = params?.event
        // Timings and owned boundary names only: never prompts, arguments,
        // model content, credential headers, or tool outputs.
        lastFrame = { method: frame.method, ...(typeof event?.type === 'string' ? { event: event.type } : {}),
          ...(typeof event?.name === 'string' ? { name: event.name } : {}), ...(typeof event?.state === 'string' ? { state: event.state } : {}) }
      } else if ('id' in frame && frame.id !== null) lastFrame = { id: frame.id }
      const now = Date.now()
      boundaries.push({ ...lastFrame, elapsedMs: now-createdAt, gapMs: now-lastFrameAt })
      if (boundaries.length>32) boundaries.shift()
      lastFrameAt = now
    },
    async run<T>(stage: string, operation: () => Promise<T>): Promise<T> {
      const startedAt = Date.now()
      const timer = setInterval(() => report(stage, startedAt, 'waiting'), 5000)
      timer.unref?.()
      let outcome: 'completed'|'failed' = 'completed'
      try { return await operation() }
      catch (error) { outcome='failed'; report(stage,startedAt,outcome); throw error }
      finally {
        clearInterval(timer)
        stages.push({ stage, elapsedMs:Date.now()-startedAt, outcome }); if (stages.length>32) stages.shift()
        if (process.env.IH_HOST_FIXTURE_TRACE==='1') report(stage,startedAt,outcome)
      }
    },
  }
}
