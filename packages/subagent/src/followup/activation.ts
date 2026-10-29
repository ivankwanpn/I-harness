/** Read-only handoff from the original assembly publication owner. */
export interface ResidentInboxActivation {
  current(): boolean
  wait(signal?: AbortSignal, pendingStop?: AbortSignal): Promise<boolean>
}
