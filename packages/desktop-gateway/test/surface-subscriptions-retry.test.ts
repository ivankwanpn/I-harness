import { expect, it } from "vitest"
import { createSurfaceSubscriptions } from "../src/observation/subscriptions.ts"

const stamp = { epoch: "e1", revision: 1 }
const lease = {
  epoch: "e1",
  withCurrent(callback: (value: typeof stamp) => void) { callback(stamp) },
  close: async () => {},
  snapshot: async () => ({ kind: "snapshot", epoch: "e1", revision: 1, value: {} }),
}

it("lets the same request key retry after an acquisition failure", async () => {
  let attempts = 0
  const source = { subscribe: async () => { attempts++; if (attempts === 1) throw new Error("boom"); return lease } }
  const subscriptions = createSurfaceSubscriptions(source as never, () => {})
  const request = { requestKey: "r1:1", surface: "execution", sessionId: "s" }
  await expect(subscriptions.subscribe(request)).rejects.toThrow("boom")
  await expect(subscriptions.subscribe(request)).resolves.toMatchObject({ requestKey: "r1:1", subscriptionId: expect.any(String) })
  // The failed attempt must not have kept a live slot: the next key is admitted.
  await expect(subscriptions.subscribe({ requestKey: "r1:2", surface: "execution", sessionId: "s" })).resolves.toBeDefined()
  await subscriptions.close()
})
