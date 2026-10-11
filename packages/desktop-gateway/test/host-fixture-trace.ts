import type { RpcMessage } from '@i-harness/sdk'

/** Keep a bounded boundary trace for host fixtures. A Vitest timeout otherwise
 * cannot distinguish initialization, prompt/tool execution, and shutdown. */
export function createHostFixtureTrace(label: string) {
  const stages: Array<{ stage: string; elapsedMs: number; outcome: 'completed'|'failed' }> = []
  let lastFrame: { method?: string; event?: string; id?: string|number } | undefined
  const report = (stage: string, startedAt: number, outcome: string) => console.warn(`[host-fixture] ${label}: ${outcome} at ${stage} ${JSON.stringify({elapsedMs:Date.now()-startedAt,lastFrame,stages})}`)
  return {
    observe(frame: RpcMessage) {
      if ('method' in frame) {
        const params = frame.params as { event?: { type?: unknown } } | undefined
        lastFrame = { method: frame.method, ...(typeof params?.event?.type === 'string' ? { event: params.event.type } : {}) }
      } else if ('id' in frame && frame.id !== null) lastFrame = { id: frame.id }
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
