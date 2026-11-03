/** The real action failure remains the cause when its existing facts or local
 * cleanup also fail. This helper never retries a producer or a save. */
export function savingFailure(primary: unknown, saving: readonly unknown[], classification: string): AggregateError {
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)
  return new AggregateError([primary, ...saving], `${message(primary)}; ${classification}: ${saving.map(message).join('; ')}`, { cause: primary })
}
