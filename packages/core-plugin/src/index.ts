import type { PluginContext } from "./types.ts"
import { createScope } from "./scope/create-scope.ts"

export type { NextFn, Listener, WaterfallHandler, CascadeHandler, GuardFn, Plugin, PluginContext } from "./types.ts"
export { CASCADE_REDISPATCH, markCascadeRedispatch, isCascadeRedispatch } from "./redispatch.ts"
export {onExecutionEvent,waterfallExecutionEvent,captureExecutionHookChannel,isExecutionHookChannel} from './execution-hooks.ts'
export type {ExecutionHookChannel} from './execution-hooks.ts'

export function createContext(): PluginContext {
  return createScope(null, null, async () => {})
}

export const corePluginVersion = "0.1.0"
