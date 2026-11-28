import { projectionFingerprint } from "@i-harness/token-meter"
import { isOfficialDeepSeekApi } from "./deepseek.ts"
import { officialXaiRoute } from "./xai.ts"

export function isOfficialOpenAIResponses(baseUrl: string | undefined): boolean {
  return baseUrl === undefined || /^https:\/\/api\.openai\.com\/?$/.test(baseUrl)
}

/** The endpoint used by the actual HTTP request and native replay. */
export function responsesEndpoint(baseUrl: string | undefined, subscription: boolean): string {
  if (subscription) return "https://chatgpt.com/backend-api/codex/responses"
  if (isOfficialOpenAIResponses(baseUrl)) return "https://api.openai.com/v1/responses"
  const xai = officialXaiRoute(baseUrl)
  if (xai) return xai.url + "/v1/responses"
  if (isOfficialDeepSeekApi(baseUrl)) return "https://api.deepseek.com/v1/responses"
  return baseUrl + "/v1/responses"
}

/** Null means this new native record has no safe replay destination. Older
 * records have no field. Never persist URL credentials or queries. */
export function responsesEndpointFingerprint(endpoint: string, subscription: boolean): string | null {
  const url = URL.parse(endpoint)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
  return projectionFingerprint(["responses-endpoint-v1", subscription, url.origin, url.pathname])
}
