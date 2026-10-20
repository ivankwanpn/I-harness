import type { SessionCoordinator, SessionMeta } from '@i-harness/session-persistence'
import type { ResultPageQuery, ResultPageResult, SessionService } from '@i-harness/session-executor'
import type { SessionManagementFence } from './session-management-fence.ts'

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
  return async (id: string, query: ResultPageQuery): Promise<ResultPageResult> => {
    try {
      return await fence.run(id, async () => {
        await visible(id)
        const page = await read(id, query)
        await visible(id)
        return page
      })
    } catch { return { kind: 'unavailable', reason: 'unavailable' } }
  }
}
