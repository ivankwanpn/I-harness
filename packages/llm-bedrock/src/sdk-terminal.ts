import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput, type ConverseStreamCommandOutput } from '@aws-sdk/client-bedrock-runtime'
import { createBedrockTerminalPayload, type BedrockTerminalPayloadOptions } from '@i-harness/llm-seam/internal/bedrock-terminal'
import { createPreparedPayload, generationError, isGenerationError, isExecutionControlError, describeTransportError, reportStreamActivity, type LLMStreamEvent } from '@i-harness/llm-seam'
import type { BedrockConfig, BedrockRuntimeFace } from './types.ts'
import { bedrockRequestOptions, generationHandlerExtension } from './transport.ts'
import { resolveBedrockRegion } from './region.ts'
import { converseInputWitness } from './request/validate-native.ts'
import { iterateConverseStream } from './stream/iterate.ts'

/** Concrete SDK terminal owns its genuine client, command and installed final
 * handler. A legacy injected send-only runtime remains standalone-only. */
export function createBedrockSdkTerminal(config: BedrockConfig, runtime?: BedrockRuntimeFace) {
  const region = runtime === undefined ? resolveBedrockRegion(config.region, process.env) : undefined
  const options = runtime === undefined ? { ...config.runtimeOptions, region, maxAttempts: 1, extensions: [generationHandlerExtension()], ...(config.profile !== undefined ? { profile: config.profile } : {}) } : undefined
  const sdk = options && new BedrockRuntimeClient(options)
  const client = sdk ?? runtime!
  return { region,
    async usesNativeEndpoint(): Promise<boolean> {
      const settings = sdk?.config
      if (!settings || settings.isCustomEndpoint || options && "endpointProvider" in options && options.endpointProvider != null) return false
      if (settings.ignoreConfiguredEndpointUrls) return true
      if (!settings.serviceConfiguredEndpoint) return false
      try {
        // The SDK's endpoint middleware awaits this same memoized provider.
        // It resolves global/service overrides and the selected shared profile.
        return !await settings.serviceConfiguredEndpoint()
      } catch {
        // An invalid configuration remains the SDK's original send error.
        return false
      }
    },
    prepare(options: Omit<BedrockTerminalPayloadOptions<ConverseStreamCommandInput>, 'execute'>, capturedConfig: BedrockConfig) {
      const payload = { ...options, async *execute(actualBody: ConverseStreamCommandInput, _serialized: string, control: import('@i-harness/llm-seam').PreparedStreamControl, execution: import('@i-harness/llm-seam').PreparedExecutionContext): AsyncIterable<LLMStreamEvent> {
        const request = { ...options.request, ...control }
        if (runtime && request.generation) throw generationError('GENERATION_UNSUPPORTED')
        let output: ConverseStreamCommandOutput
        const inputWitness = converseInputWitness(actualBody)
        try {
          if (runtime) (await execution.reserve())(capturedConfig.executionIdentity)
          output = await client.send(new ConverseStreamCommand(actualBody), runtime ? { abortSignal: request.signal } : bedrockRequestOptions(request.signal, async () => {
            const issue = await execution.reserve()
            return () => issue(capturedConfig.executionIdentity)
          }))
        } catch (error) {
          if (isGenerationError(error) || isExecutionControlError(error) || request.signal?.aborted) throw error
          yield { type: 'error', error: await describeTransportError('bedrock', resolveBedrockRegion(capturedConfig.region, process.env), error, { remediation: 'none' }) }
          return
        }
        reportStreamActivity(request, 'response-start')
        yield* iterateConverseStream(output, capturedConfig, request, inputWitness)
      } }
      return runtime ? createPreparedPayload(payload) : createBedrockTerminalPayload(payload)
    },
  }
}
