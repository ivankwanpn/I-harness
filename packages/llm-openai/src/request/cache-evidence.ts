/** Private insertion record. Raw/config/request fields never populate it. */
export interface GeneratedAffinity {
  readonly adapter: "openai-responses-subscription"
  readonly revision: "subscription-affinity-v1"
  readonly path: "prompt_cache_key"
  readonly value: string
}
