import { stringifyJsonData } from "@i-harness/core-session"
import { projectionFingerprint } from "./fingerprint.ts"
import { priceProjectedBytes } from "./pricing.ts"
import { semanticInputIdentity, semanticProjectionDigest } from "./identity.ts"
import type { ComponentFacts, InputComponent, ProjectedInputFacts } from "./types.ts"
const categories: InputComponent[] = ['system', 'toolSchemas', 'visibleText', 'toolArguments', 'toolResults', 'replayedReasoning', 'opaqueContinuation', 'images', 'otherInput', 'framing']
export class ProjectionCounter {
  constructor(private readonly pricingVersion?: "projected-pricing-v2", private readonly assistantOrder?: "one-unit-per-assistant") {}
  readonly components = Object.fromEntries(categories.map(key => [key, { textUtf8Bytes: 0, structuredBytes: 0, binaryBytes: 0, imageCount: 0, blockCount: 0, heuristicTokens: 0 }])) as Record<InputComponent, ComponentFacts>;
  readonly uncertainties = new Set<string>();
  readonly units: {
    fingerprint: string
    role?: 'user' | 'assistant' | 'tool'
    heuristicTokens: number
    sourceAssistantOrdinal?: number
    replayedReasoningTokens?: number
    semanticId?: string
  }[] = [];
  inlineBinaryBytes = 0;
  cacheMetadataBytes = 0;
  signatureBytes = 0;
  private unpricedBlocksInUnits = 0;
  private lastUnpricedUnit?: number;
  private nextAssistantOrdinal = 0
  private unpricedBlocks(): number { return this.components.images.blockCount + this.components.opaqueContinuation.blockCount }
  private total(): number { return categories.reduce((sum, key) => sum + this.components[key].heuristicTokens, 0) }
  text(category: InputComponent, value: unknown): void {
    if (value === undefined)
      return
    const text = typeof value === "string" ? value : stringifyJsonData(value) ?? ""
    const facts = this.components[category]
    const bytes = Buffer.byteLength(text)
    facts.textUtf8Bytes += bytes
    facts.blockCount++
    facts.heuristicTokens += priceProjectedBytes(text, bytes) + 4
  }
  structured(category: InputComponent, value: unknown): void {
    if (value === undefined)
      return
    const text = stringifyJsonData(value) ?? ""
    const facts = this.components[category]
    const bytes = Buffer.byteLength(text)
    facts.structuredBytes += bytes
    facts.blockCount++
    facts.heuristicTokens += priceProjectedBytes(text, bytes) + 4
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
  unit(value: unknown, role: 'user' | 'assistant' | 'tool' | undefined, visit: () => void, sourceAssistantOrdinal?: number): void {
    if (this.assistantOrder && role === 'assistant') sourceAssistantOrdinal = this.nextAssistantOrdinal++
    const replayBefore = this.components.replayedReasoning.heuristicTokens
    const start = this.total()
    const unpricedBefore = this.unpricedBlocks()
    this.components.framing.blockCount++
    this.components.framing.heuristicTokens += 12
    visit()
    const addedUnpriced = this.unpricedBlocks() - unpricedBefore
    if (addedUnpriced > 0) {
      this.unpricedBlocksInUnits += addedUnpriced
      this.lastUnpricedUnit = this.units.length
    }
    const semanticId = this.pricingVersion ? semanticProjectionDigest("unit", value) : undefined
    const replayedReasoningTokens = this.components.replayedReasoning.heuristicTokens - replayBefore
    this.units.push({ fingerprint: semanticId ?? projectionFingerprint(value), ...(semanticId ? { semanticId } : {}), ...(role ? { role } : {}), heuristicTokens: this.total() - start,
      ...(sourceAssistantOrdinal !== undefined && replayedReasoningTokens > 0 ? { sourceAssistantOrdinal, replayedReasoningTokens } : {}) })
  }
  /** Only invoke on protocol blocks, never schemas/tool argument objects. */
  metadata(value: Record<string, unknown>): void {
    for (const key of ['cache_control', 'cachePoint', 'prompt_cache_breakpoint', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'cachedContent'])
      if (value[key] !== undefined)
        this.cacheMetadataBytes += Buffer.byteLength(stringifyJsonData(value[key])!)
    for (const key of ['signature', 'thoughtSignature'])
      if (typeof value[key] === "string") {
        const bytes = Buffer.byteLength(value[key])
        this.signatureBytes += bytes
        // A signature is opaque bytes, but pricing them heuristically cannot
        // hide the rest of the request: keep the uncertainty, not the block.
        this.uncertainties.add("signature-token-cost")
        const facts = this.components.opaqueContinuation
        facts.textUtf8Bytes += bytes
        facts.blockCount++
        facts.heuristicTokens += Math.ceil(bytes / 2) + 4
      }
  }
  finish(identity: {
    protocol: string
    providerId?: string
    modelId: string
    expectedModelId?: string
  }, input: unknown, shape: unknown, overrides: ProjectedInputFacts['overriddenInputFields'] = [], coverage: ProjectedInputFacts['coverage'] = 'complete'): ProjectedInputFacts {
    const semanticIdentity = this.pricingVersion ? semanticInputIdentity(identity, shape, input, this.units) : undefined
    const needsProviderPricing = this.uncertainties.has('image-token-cost') || this.uncertainties.has('opaque-continuation-token-cost')
    return {
      version: 1, ...identity,
      bindingFingerprint: projectionFingerprint(identity), shapeFingerprint: semanticIdentity ? projectionFingerprint(['projection-compat-v2', semanticIdentity.shapeId, semanticIdentity.pricingVersion]) : projectionFingerprint(shape), inputFingerprint: semanticIdentity?.semanticId ?? projectionFingerprint(input),
      ...(semanticIdentity ? { semanticIdentity } : {}),
      ...(semanticIdentity && needsProviderPricing && coverage === 'complete' && this.lastUnpricedUnit !== undefined && this.unpricedBlocksInUnits === this.unpricedBlocks()
        ? { lastUnpricedUnit: this.lastUnpricedUnit } : {}),
      units: this.units, components: this.components, coverage, uncertainties: [...this.uncertainties],
      overriddenInputFields: overrides,
    }
  }
}
