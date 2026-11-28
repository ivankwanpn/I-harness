import { projectionFingerprint } from "@i-harness/token-meter"

export function isOfficialDeepSeekApi(baseUrl?: string): boolean {
  return /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/i.test(baseUrl ?? "")
}

export function deepSeekCallFingerprint(call: { id?: string; name: string; args: unknown }): string {
  return projectionFingerprint([call.id ?? null, call.name, call.args])
}
