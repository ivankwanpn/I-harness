import type { BackendClient } from "../src/contracts.ts"

type SessionManagementMethods = Pick<
  BackendClient,
  "createSession" | "forkSession" | "modelState" | "setSessionModel"
>

function unavailable(method: string): never {
  throw new Error(`${method} unavailable in this test backend`)
}

export const unsupportedSessionManagement: SessionManagementMethods = {
  createSession: async () => unavailable("session-create"),
  forkSession: async () => unavailable("session-fork"),
  modelState: async () => unavailable("session-model"),
  setSessionModel: async () => unavailable("session-model"),
}
