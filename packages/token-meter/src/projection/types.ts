export type InputComponent = 'system' | 'toolSchemas' | 'visibleText' | 'toolArguments' | 'toolResults' | 'replayedReasoning' | 'opaqueContinuation' | 'images' | 'otherInput' | 'framing'
export interface ComponentFacts {
  textUtf8Bytes: number
  structuredBytes: number
  binaryBytes: number
  imageCount: number
  blockCount: number
  heuristicTokens: number
}
export interface ProjectedInputFacts {
  version: 1
  protocol: string
  providerId?: string
  modelId: string
  expectedModelId?: string
  bindingFingerprint: string
  shapeFingerprint: string
  inputFingerprint: string
  units: readonly {
    fingerprint: string
    role?: 'user' | 'assistant' | 'tool'
    heuristicTokens: number
  }[]
  components: Readonly<Record<InputComponent, ComponentFacts>>
  coverage: 'complete' | 'neutral-only' | 'incomplete'
  uncertainties: readonly string[]
  overriddenInputFields: readonly ('model' | 'system' | 'messages' | 'tools')[]
}
export interface PreparedRequestMeasurement {
  projectionId: string
  input: ProjectedInputFacts
  output: {
    capSupport: 'supported' | 'unsupported' | 'unknown'
    configuredCap?: number
    effectiveCap?: number
    minimumCap: number
    reasoningBudget?: number
    source: 'request' | 'route' | 'adapter-default' | 'provider-default'
  }
  packet: {
    sizeKind: 'http-json-body' | 'sdk-command-estimate' | 'neutral-envelope-estimate'
    bodyBytes?: number
    sdkCommandBytesEstimate?: number
    inlineBinaryBytes: number
    cacheMetadataBytes: number
    signatureBytes: number
  }
}
