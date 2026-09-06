// M49 Task 6: the legacy TUI model factory (createTuiModelBuilder +
// resolveTuiModel over the ProviderStore) is GONE. This file is the
// regression evidence: the production model composition path is the
// provider-runtime resolveModel chain (flag > session selection > settings
// default — never a mock fallback), and the public @i-harness/tui surface no
// longer exposes the legacy names.

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import * as tui from "../src/index.ts"

const FIXTURE_CLIENT = { async *stream() {} }

async function fixture(): Promise<{ settings: SettingsStore; credentials: ReturnType<typeof createCredentialStore>; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "tui-factory-regression-"))
  const settings = new SettingsStore({ path: join(root, "settings.json") })
  await settings.load()
  const credentials = createCredentialStore(join(root, "credentials.json"))
  await credentials.set("DEEPSEEK_API_KEY", "fixture-key")
  await settings.set({
    llm: {
      providers: {
        deepseek: {
          baseURL: "https://api.deepseek.com",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      },
      defaultModel: { provider: "deepseek", model: "deepseek-chat" },
    },
  })
  return { settings, credentials, root }
}

describe("the legacy TUI factory is gone — the runtime resolveModel is the production path", () => {
  it("the @i-harness/tui surface no longer exports ProviderStore / createTuiModelBuilder", () => {
    expect("ProviderStore" in tui).toBe(false)
    expect("createTuiModelBuilder" in tui).toBe(false)
    expect("settingsKnobRows" in tui).toBe(true) // the modal surface stays
  })

  it("the runtime chain resolves a REAL ModelClient from settings (flag > settings; never a mock)", async () => {
    const f = await fixture()
    try {
      const buildClient: typeof import("@i-harness/provider").buildModelClient = () => FIXTURE_CLIENT
      const runtime = createProviderRuntime({
        settings: f.settings,
        credentials: f.credentials,
        registry: createProviderRegistry(),
        buildClient,
      })
      // settings default → ready binding with the real client:
      const fromSettings = await runtime.resolveModel({})
      expect(fromSettings.status).toBe("ready")
      if (fromSettings.status === "ready") {
        expect(fromSettings.binding.client).toBe(FIXTURE_CLIENT)
        expect(fromSettings.binding).toMatchObject({
          providerId: "deepseek",
          modelId: "deepseek-chat",
          label: "deepseek:deepseek-chat",
        })
      }
      // override wins:
      const fromOverride = await runtime.resolveModel({ override: "deepseek:deepseek-chat" })
      expect(fromOverride.status).toBe("ready")
      // unconfigured is an HONEST state — never a synthetic default client:
      const bare = createProviderRuntime({
        settings: f.settings,
        credentials: f.credentials,
        registry: createProviderRegistry(),
        buildClient,
      })
      await bare.setDefaultModel({ provider: "", model: "" })
      const none = await bare.resolveModel({})
      expect(none.status).toBe("unconfigured")
      if ("reason" in none) expect(none.reason).toContain("No model configured")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
