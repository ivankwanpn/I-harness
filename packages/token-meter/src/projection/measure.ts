import { stringifyJsonData } from "@i-harness/core-session"
import { projectionFingerprint } from "./fingerprint.ts"
import { priceProjectedText } from "./pricing.ts"
import { semanticInputIdentity, semanticProjectionDigest } from "./identity.ts"
import type { ComponentFacts, InputComponent, ProjectedInputFacts } from "./types.ts"
const categories: InputComponent[] = ['system', 'toolSchemas', 'visibleText', 'toolArguments', 'toolResults', 'replayedReasoning', 'opaqueContinuation', 'images', 'otherInput', 'framing']
export class ProjectionCounter {
  constructor(private readonly pricingVersion?: "projected-pricing-v2") {}
  readonly components = Object.fromEntries(categories.map(key => [key, { textUtf8Bytes: 0, structuredBytes: 0, binaryBytes: 0, imageCount: 0, blockCount: 0, heuristicTokens: 0 }])) as Record<InputComponent, ComponentFacts>;
  readonly uncertainties = new Set<string>();
  readonly units: {
    fingerprint: string
    role?: 'user' | 'assistant' | 'tool'
    heuristicTokens: number
    semanticId?: string
  }[] = [];
  inlineBinaryBytes = 0;
  cacheMetadataBytes = 0;
  signatureBytes = 0;
  private total(): number { return categories.reduce((sum, key) => sum + this.components[key].heuristicTokens, 0) }
  text(category: InputComponent, value: unknown): void {
    if (value === undefined)
      return
    const text = typeof value === "string" ? value : stringifyJsonData(value) ?? ""
    const facts = this.components[category]
    facts.textUtf8Bytes += Buffer.byteLength(text)
    facts.blockCount++
    facts.heuristicTokens += priceProjectedText(text) + 4
  }
  structured(category: InputComponent, value: unknown): void {
    if (value === undefined)
      return
    const text = stringifyJsonData(value) ?? ""
    const facts = this.components[category]
    facts.structuredBytes += Buffer.byteLength(text)
    facts.blockCount++
    facts.heuristicTokens += priceProjectedText(text) + 4
  }
  opaque(value: unknown): void {
    const bytes = value instanceof Uint8Array ? value.byteLength : Buffer.byteLength(typeof value === "string" ? value : stringifyJsonData(value) ?? "")
    const facts = this.components.opaqueContinuation
    facts.binaryBytes += bytes
    facts.blockCount++
    facts.heuristicTokens += Math.ceil(bytes / 2) + 4
    this.uncertainties.add("opaque-continuation-token-cost")
  }
  image(value: unknown): void {
    const bytes = value instanceof Uint8Array ? value.byteLength : typeof value === "string" ? Buffer.byteLength(value, "base64") : 0
    const facts = this.components.images
    facts.binaryBytes += bytes
    facts.imageCount++
    facts.blockCount++
    facts.heuristicTokens += Math.max(2048, Math.ceil(bytes / 256))
    this.inlineBinaryBytes += bytes
    this.uncertainties.add("image-token-cost")
  }
  unit(value: unknown, role: 'user' | 'assistant' | 'tool' | undefined, visit: () => void): void {
    const start = this.total()
    this.components.framing.blockCount++
    this.components.framing.heuristicTokens += 12
    visit()
    const semanticId = this.pricingVersion ? semanticProjectionDigest("unit", value) : undefined
    this.units.push({ fingerprint: semanticId ?? projectionFingerprint(value), ...(semanticId ? { semanticId } : {}), ...(role ? { role } : {}), heuristicTokens: this.total() - start })
  }
  /** Only invoke on protocol blocks, never schemas/tool argument objects. */
  metadata(value: Record<string, unknown>): void {
    for (const key of ['cache_control', 'cachePoint', 'prompt_cache_breakpoint', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'cachedContent'])
      if (value[key] !== undefined)
        this.cacheMetadataBytes += Buffer.byteLength(stringifyJsonData(value[key])!)
    for (const key of ['signature', 'thoughtSignature'])
      if (typeof value[key] === "string") {
        this.signatureBytes += Buffer.byteLength(value[key])
        this.uncertainties.add("signature-token-cost")
        this.opaque(value[key])
      }
  }
  finish(identity: {
    protocol: string
    providerId?: string
    modelId: string
    expectedModelId?: string
  }, input: unknown, shape: unknown, overrides: ProjectedInputFacts['overriddenInputFields'] = [], coverage: ProjectedInputFacts['coverage'] = 'complete'): ProjectedInputFacts {
    const semanticIdentity = this.pricingVersion ? semanticInputIdentity(identity, shape, input, this.units) : undefined
    return {
      version: 1, ...identity,
      bindingFingerprint: projectionFingerprint(identity), shapeFingerprint: semanticIdentity ? projectionFingerprint(['projection-compat-v2', semanticIdentity.shapeId, semanticIdentity.pricingVersion]) : projectionFingerprint(shape), inputFingerprint: semanticIdentity?.semanticId ?? projectionFingerprint(input),
      ...(semanticIdentity ? { semanticIdentity } : {}),
      units: this.units, components: this.components, coverage, uncertainties: [...this.uncertainties],
      overriddenInputFields: overrides,
    }
  }
}
