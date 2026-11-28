import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { LLMRequest } from "@i-harness/llm-seam"
import { createBedrockClient, type BedrockConfig } from "../src/index.ts"

const model = "anthropic.claude-3-7-sonnet-20250219-v1:0"
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const request: LLMRequest = { systemPrompt: "", tools: [], maxOutputTokens: 4096, messages: [
  { role: "user", content: "Inspect the image" },
  { role: "assistant", content: "", toolCalls: [{ id: "image-call", name: "read", args: {} }] },
  { role: "tool", toolCallId: "image-call", isError: true, content: [{ type: "text", text: "fixture error" }, { type: "image", image: { mediaType: "image/png", dataBase64: png } }] },
] }
afterEach(() => vi.unstubAllEnvs())

it.each(["default", "explicit", "resolver", "global", "service", "profile", "services", "ignored"] as const)(
  "qualifies image, status and thinking against the actual SDK handler destination (%s)", async route => {
    const root = await mkdtemp(join(tmpdir(), "ih-bedrock-route-"))
    try {
      const profile = "local-fixture", configPath = join(root, "config"), credentialsPath = join(root, "credentials")
      const url = "https://" + route + ".bedrock.invalid"
      const globalEndpoint = ["global", "service", "explicit", "ignored"].includes(route)
      vi.stubEnv("AWS_PROFILE", profile)
      vi.stubEnv("AWS_CONFIG_FILE", configPath)
      vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsPath)
      vi.stubEnv("AWS_ENDPOINT_URL", globalEndpoint ? "https://global.bedrock.invalid" : undefined)
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", route === "service" || route === "explicit" ? "https://service.bedrock.invalid" : undefined)
      vi.stubEnv("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", route === "ignored" ? "true" : undefined)
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false")
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false")
      vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true")
      const profileSettings = route === "profile" ? "endpoint_url = " + url : route === "services" ? "services = overrides\n[services overrides]\nbedrock_runtime =\n  endpoint_url = " + url : ""
      await writeFile(configPath, "[profile " + profile + "]\n" + profileSettings + "\n")
      await writeFile(credentialsPath, "")
      const native = route === "default" || route === "ignored"
      const credentials = vi.fn(async () => ({ accessKeyId: "LOCAL_FIXTURE", secretAccessKey: "local-only" }))
      const handle = vi.fn(async (_req: { hostname: string; body?: string | Uint8Array }) => ({
        response: { statusCode: 400, headers: { "content-type": "application/json" }, body: Buffer.from('{"message":"local fixture stopped after serialization"}') },
      }))
      const config: BedrockConfig = { model, region: "us-east-1", inputModalities: ["text", "image"], options: { thinking: { type: "enabled", budget_tokens: 2048 } },
        runtimeOptions: { credentials, ...(route === "explicit" ? { endpoint: url } : {}),
          ...(route === "resolver" ? { endpointProvider: () => ({ url: new URL(url) }) } : {}),
          requestHandler: { handle, destroy() {}, updateHttpClientConfig() {}, httpHandlerConfigs() { return {} } } } }
      const client = createBedrockClient(config)
      const prepared = await client.prepare!(request)
      expect(credentials).not.toHaveBeenCalled()
      expect(handle).not.toHaveBeenCalled()
      // The real signer and endpoint resolver run; this handler replaces the transport.
      for await (const _event of prepared.stream()) {}
      expect(handle).toHaveBeenCalledTimes(1)
      const [{ hostname, body }] = handle.mock.calls[0]!
      expect(hostname).toBe(native ? "bedrock-runtime.us-east-1.amazonaws.com" : new URL(url).hostname)
      const messages = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)).messages
      const result = messages[2].content[0].toolResult
      expect(result.status).toBe(native ? "error" : undefined)
      expect(result.content.some((part: { image?: unknown }) => part.image !== undefined)).toBe(native)
      if (!native) {
        expect(result.content).toContainEqual({ json: { isError: true } })
        expect(messages[3].content).toContainEqual({ image: { format: "png", source: { bytes: png } } })
      }
      expect(prepared.measurement.output.minimumCap).toBe(native ? 2049 : 1)
      if (!native) expect(prepared.withOutputCap(1000).measurement.output.effectiveCap).toBe(1000)
    } finally { await rm(root, { recursive: true, force: true }) }
  },
)
