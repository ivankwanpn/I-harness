import { createContext } from '../../../core-plugin/src/index.ts'
import { createToolRegistry, isNativePlanValidationError, type Tool, type ToolExec } from '@i-harness/core-tools'
import { createFsTools as original, type FsToolDeps } from '../../src/index.ts'

/** Legacy body-oriented tests go through the genuine registry capture/dispatch. */
export function createFsTools(deps: FsToolDeps): Tool[] {
  return original(deps).map(tool => {
    const registry = createToolRegistry(createContext())
    registry.register(tool)
    return { ...tool, async execute(args: unknown, exec: ToolExec) {
      try {
        const data = JSON.parse(JSON.stringify(args))
        const capture = registry.capture({ name: tool.name, args: data }, {
          ...(exec.session ? { session: exec.session } : {}), ...(exec.sessionId ? { sessionId: exec.sessionId } : {}),
          ...(exec.callId ? { callId: exec.callId } : {}), ...(exec.callEventSeq !== undefined ? { callEventSeq: exec.callEventSeq } : {}),
          ...(exec.modelGeneration ? { modelGeneration: exec.modelGeneration } : {}), ...(exec.resultConsumer ? { resultConsumer: exec.resultConsumer } : {}),
        })
        return await registry.dispatch(await registry.prepareCaptured(capture, exec.abortSignal))
      } catch (error) {
        if (isNativePlanValidationError(error)) return error.output
        throw error
      }
    } }
  })
}
