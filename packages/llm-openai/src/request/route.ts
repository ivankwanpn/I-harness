/** Public Responses features need the first-party endpoint, not a model alias alone. */
export function isOfficialOpenAIResponses(baseUrl: string | undefined): boolean {
  return baseUrl === undefined || /^https:\/\/api\.openai\.com\/?$/.test(baseUrl)
}
