import {createEffectiveLocalInputs} from './effective-local-inputs.ts'
import {classifyOwnedGatewayHooks} from './owned-gateway-hook-selection.ts'
import type {createDesktopPlugins} from './plugins.ts'
import type {createDesktopMcp} from './mcp-settings.ts'

/** Capture the original plugin registry and effective local hook list before
 * selection. Currentness re-reads those same original owners synchronously. */
export async function captureOwnedGatewaySelection(options:{plugins:ReturnType<typeof createDesktopPlugins>;mcp:ReturnType<typeof createDesktopMcp>;workspace:string;configDir:string}) {
 const witness=await options.plugins.inputsWitness()
 // Direct MCP configuration is applied through the live extension capabilities,
 // not captured into the plugin selection witness: a settings change must not
 // invalidate every live session's selection.
 const mcp=await options.mcp.snapshot()
 witness.assertCurrent()
 const effective=createEffectiveLocalInputs(options.workspace,options.configDir,witness.inputs)
 const snapshot=JSON.stringify(effective)
 const assertInputsCurrent=()=>{witness.assertCurrent();if(JSON.stringify(effective)!==snapshot||JSON.stringify(createEffectiveLocalInputs(options.workspace,options.configDir,witness.inputs))!==snapshot)throw Error('Effective plugin inputs changed after selection')}
 assertInputsCurrent()
 const decision=await classifyOwnedGatewayHooks({configDir:options.configDir,hookConfigs:effective.hookConfigs,assertInputsCurrent})
 decision.assertCurrent()
 return Object.freeze({kind:decision.kind,inputs:effective,directMcp:mcp,assertCurrent:decision.assertCurrent})
}
