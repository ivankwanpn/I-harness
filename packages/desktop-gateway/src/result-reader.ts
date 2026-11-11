import type { SessionCoordinator, SessionMeta } from '@i-harness/session-persistence'
import type { ResultPageQuery, ResultPageResult, SessionService } from '@i-harness/session-executor'
import type { SessionManagementFence } from './session-management-fence.ts'

type SeedPageEvent = { type: string; page?: { rows?: { ref?: { id?: string } }[] } }
const unavailable = (): ResultPageResult => ({ kind: 'unavailable', reason: 'unavailable' })
const isUnavailable = (page: ResultPageResult): boolean => 'kind' in page && (page as { kind?: string }).kind === 'unavailable'

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
    fence.assertUnblocked(id)
    const { meta } = await coordinator.profile(id)
    if (meta.archived || !await isConversation(id, meta)) throw new Error('Conversation unavailable')
    fence.assertUnblocked(id)
  }
  async function direct(id: string, query: ResultPageQuery): Promise<ResultPageResult> {
    try { return await read(id, query) } catch { return unavailable() }
  }
  return async (id: string, query: ResultPageQuery): Promise<ResultPageResult> => {
    try {
      return await fence.run(id, async () => {
        await visible(id)
        const page = await direct(id, query)
        await visible(id)
        if (!isUnavailable(page)) return page
        // A fork child inherits page metadata only; the bytes live in an
        // ancestor's result store. Walk the parent chain (bounded) so nested
        // forks keep reading what they inherited.
        const refId = (query as { ref?: { id?: string } }).ref?.id
        if (refId === undefined) return page
        if (!(await inheritedRefIds(coordinator, id)).has(refId)) return page
        fence.assertUnblocked(id)
        let current = id
        for (let depth = 0; depth < 16; depth++) {
          const { meta } = await coordinator.profile(current)
          const parent = meta.parentSession
          if (parent === undefined || parent === current) return page
          fence.assertUnblocked(id)
          fence.assertUnblocked(parent)
          const candidate = await direct(parent, query)
          fence.assertUnblocked(parent)
          fence.assertUnblocked(id)
          if (!isUnavailable(candidate)) return candidate
          current = parent
        }
        return page
      })
    } catch { return unavailable() }
  }
}
