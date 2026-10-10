type Result = { name: string; outcome: "pass" | "fail" | "unsupported"; detail: unknown }
type Teardown = { name: string; dispose(): Promise<void> }

/** Finish every owner cleanup attempt before serializing qualification evidence. */
export async function recordTeardownFailures(results: Result[], actions: readonly Teardown[]): Promise<void> {
  for (const action of actions) {
    try { await action.dispose() }
    catch (cause) {
      results.push({ name: `${action.name}-teardown`, outcome: "fail",
        detail: cause instanceof Error ? cause.message : String(cause) })
    }
  }
}
