import type { SessionCoordinator, SessionMeta } from '@i-harness/session-persistence'
import type { ResultPageQuery, ResultPageResult, SessionService } from '@i-harness/session-executor'
import type { SessionManagementFence } from './session-management-fence.ts'

type SeedPageEvent = { type: string; page?: { rows?: { ref?: { id?: string } }[] }; results?: { rows?: number } }

/** The ref ids a fork child inherited (its seed result pages). */
async function inheritedRefIds(coordinator: SessionCoordinator, id: string): Promise<Set<string>> {
  const { session } = await coordinator.load(id)
  const ids = new Set<string>()
  for (const event of session.events as SeedPageEvent[]) {
    if (event.type !== 'conversation/seed-results') continue
    for (const row of event.page?.rows ?? []) if (typeof row.ref?.id === 'string') ids.add(row.ref.id)
  }
  return ids
}

/** Host visibility is independent of the original store's pin/source policy. */
export function createConversationResultReader(coordinator: SessionCoordinator, service: Pick<SessionService, 'readResultPage'>,
  isConversation: (id: string, meta: SessionMeta) => Promise<boolean>, fence: SessionManagementFence) {
  if (!service.readResultPage) return undefined
  const read = service.readResultPage
  async function visible(id: string) {
    fence.assertOpen(id)
    const { meta } = await coordinator.profile(id)
    if (meta.archived || !await isConversation(id, meta)) throw new Error('Conversation unavailable')
    fence.assertOpen(id)
  }
  /** A fork child reads an inherited page through its source: the bytes live in
   *  the source's result store and the child carries only the page metadata. */
  async function inheritedSource(id: string, refId: string | undefined): Promise<string | undefined> {
    if (refId === undefined) return undefined
    const { meta } = await coordinator.profile(id)
    const parent = meta.parentSession
    if (parent === undefined || parent === id) return undefined
    return (await inheritedRefIds(coordinator, id)).has(refId) ? parent : undefined
  }
  return async (id: string, query: ResultPageQuery): Promise<ResultPageResult> => {
    try {
      return await fence.run(id, async () => {
        await visible(id)
        const page = await read(id, query)
        await visible(id)
        if (!('kind' in page) || (page as { kind?: string }).kind !== 'unavailable') return page
        const source = await inheritedSource(id, (query as { ref?: { id?: string } }).ref?.id)
        if (source === undefined) return page
        fence.assertOpen(source)
        const inherited = await read(source, query)
        fence.assertOpen(id)
        return inherited
      })
    } catch { return { kind: 'unavailable', reason: 'unavailable' } }
  }
}