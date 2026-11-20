import type { OpenAIConfig } from "../types.ts"

export function isDeepSeekResponses(config: Pick<OpenAIConfig, "baseUrl" | "providerId">): boolean {
  return config.providerId === "deepseek" && /^https:\/\/api\.deepseek\.com\/?$/i.test(config.baseUrl ?? "")
}
