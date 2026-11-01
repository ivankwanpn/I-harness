import type { LLMUsage } from "@i-harness/llm-seam"

/** M72 Ⅲ: the Responses shape → the seam's `LLMUsage`. Field names differ from
 * message-start's, so the mapper lives per wire (the seam owns the vocabulary,
 * each adapter owns its spelling). */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
  const details=object(r.input_tokens_details)?r.input_tokens_details:{}
  const out: LLMUsage = {}
  let invalid=r.input_tokens_details!==undefined&&!object(r.input_tokens_details)
  const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
  const take = (from: unknown, to: Exclude<keyof LLMUsage, "inputTokenSemantics"|'measurementValidity'>): void => {
    if(from!==undefined&&!count(from))invalid=true
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.input_tokens, "inputTokens")
  take(r.output_tokens, "outputTokens")
  take(details.cached_tokens, "cacheReadTokens")
  take(details.cache_write_tokens,'cacheCreationTokens')
  // The aggregate is reported independently. Never derive it from a partial
  // TTL split, nor turn absent cache-write accounting into measured zero.
  if(details.cache_write_tokens_details!==undefined){
    const split=details.cache_write_tokens_details
    if(!object(split))invalid=true
    else{
      const short=split.ttl_30m_tokens,long=split.ttl_12h_tokens,aggregate=details.cache_write_tokens
      for(const value of [short,long])if(value!==undefined&&!count(value))invalid=true
      if(count(aggregate)){
        if(count(short)&&short>aggregate||count(long)&&long>aggregate)invalid=true
        if(count(short)&&count(long)&&(!Number.isSafeInteger(short+long)||short+long!==aggregate))invalid=true
      }
    }
  }
  if(count(out.inputTokens)&&(count(out.cacheReadTokens)&&out.cacheReadTokens>out.inputTokens||count(out.cacheCreationTokens)&&out.cacheCreationTokens>out.inputTokens||count(out.cacheReadTokens)&&count(out.cacheCreationTokens)&&out.cacheReadTokens+out.cacheCreationTokens>out.inputTokens))invalid=true
  if(invalid)out.measurementValidity='invalid'
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "includes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
