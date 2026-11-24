import { dirname, join } from "node:path"
import { createCodexManagement } from "@i-harness/coding-plans"
import { createFileProviderRuntime } from "@i-harness/provider-runtime/file"
import { decodeFrame, encodeFrame, isRpcRequest, makeFailure, makeSuccess, INVALID_REQUEST, METHOD_NOT_FOUND, PROTOCOL_VERSION } from "@i-harness/sdk"
import { resolveSettingsPath, SettingsStore } from "@i-harness/settings"
import { createUsageStore } from "@i-harness/usage-stats"
import { createAutoTitleSettings } from "./auto-title.ts"
import { createCodingPlans } from "./coding-plans.ts"
import type { DesktopHost } from "./host.ts"
import { createModelRetrySettings } from "./model-retry-settings.ts"
import { createModelWaitSettings } from "./model-wait-settings.ts"
import { createDesktopRouter, createGatewayWrite } from "./router.ts"
import { validateDesktopSettingsDocument } from "./settings-file.ts"
import type { DesktopHandlers, GatewayWrite } from "./types.ts"
import { createUsageHandlers } from "./usage-host.ts"

/** Process-owned profile services. A workspace borrows the account manager
 * for its own model traffic, which retains the workspace's usage attribution. */
export function createDesktopProfileServices(settingsPath = resolveSettingsPath(), credentialsPath = join(dirname(settingsPath), "credentials.json")) {
  const accounts = createCodexManagement({ directory: join(dirname(credentialsPath), "coding-plans", "openai-codex") })
  const provider = createFileProviderRuntime({ settingsPath, credentialsPath, codex: accounts })
  const codingPlans = createCodingPlans(accounts, provider)
  const usageStore = createUsageStore(join(dirname(settingsPath), "usage-stats"))
  return { settingsPath, credentialsPath, accounts, provider, codingPlans, usageStore, close: () => codingPlans.close() }
}

export type DesktopProfileServices = ReturnType<typeof createDesktopProfileServices>

/** Use the existing Desktop RPC handlers with only the profile's capabilities.
 * Configuration needs no session database, execution service or filesystem policy. */
export async function createConfigurationHost(profile: DesktopProfileServices, send: GatewayWrite): Promise<DesktopHost> {
  await new SettingsStore({ path: profile.settingsPath }).loadObserved({ validate: validateDesktopSettingsDocument })
  const handlers: DesktopHandlers = {
    hasActiveWork: () => profile.accounts.hasActiveLogin(),
    provider: profile.provider, codingPlans: profile.codingPlans,
    autoTitle: createAutoTitleSettings(profile.settingsPath),
    modelRetry: createModelRetrySettings(profile.settingsPath),
    modelWait: createModelWaitSettings(profile.settingsPath),
    usageStats: createUsageHandlers(profile.usageStore, { recordingMode: "observations", warnings: () => [] }),
  }
  const write = createGatewayWrite(send, handlers)
  let initialized = false
  const router = createDesktopRouter({
    async handleLine(line) {
      const frame = decodeFrame(line)
      if (!isRpcRequest(frame)) return null
      let response
      if (frame.method === "initialize") {
        initialized = true
        response = makeSuccess(frame.id, { name: "i-harness", version: "0.1.0", protocolVersion: PROTOCOL_VERSION, capabilities: {} })
      } else if (frame.method === "shutdown" || (initialized && frame.method === "ping")) {
        response = makeSuccess(frame.id, { ok: true })
      } else if (!initialized) {
        response = makeFailure(frame.id, INVALID_REQUEST, "not initialized: send initialize first", { reason: "not_initialized" })
      } else {
        response = makeFailure(frame.id, METHOD_NOT_FOUND, `Unknown configuration method: ${frame.method}`)
      }
      write(response)
      return encodeFrame(response)
    },
    async close() {},
  }, send, handlers)
  return router
}
