import type { RuntimeExtension } from '@aws-sdk/client-bedrock-runtime'

/** Request-local capability survives Smithy's conditional options spread. */
const beforePhysicalIssue = Symbol('bedrock-generation-issue')
type BeforeIssue = () => Promise<() => void>
export function bedrockRequestOptions(abortSignal: AbortSignal | undefined, before: BeforeIssue) {
  return { ...(abortSignal ? { abortSignal } : {}), [beforePhysicalIssue]: before }
}
/** Supported SDK extension: no global request slot or transitive SDK mutation. */
export function generationHandlerExtension(): RuntimeExtension {
  return { configure(configuration) {
    const underlying = configuration.httpHandler()
    configuration.setHttpHandler(new Proxy(underlying, { get(target, property) {
      if (property === 'handle') return async (...[request, options]: Parameters<typeof underlying.handle>) => {
        const { [beforePhysicalIssue]: before, ...networkOptions } = options as typeof options & { [beforePhysicalIssue]?: BeforeIssue }
        const issue = await before?.()
        if (options?.abortSignal?.aborted) throw Object.assign(new Error('Bedrock request aborted'), { name: 'AbortError', code: 'ABORTED' })
        issue?.()
        return target.handle(request, networkOptions)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }))
  } }
}
