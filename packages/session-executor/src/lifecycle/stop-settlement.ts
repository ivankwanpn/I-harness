/** A resistant provider or cleanup task must leave the UI free to offer Force stop. */
export async function waitForStopSettlement(settlement: Promise<unknown>): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([settlement, new Promise<void>(resolve => { deadline = setTimeout(resolve, 2500) })])
  } finally { clearTimeout(deadline) }
}
