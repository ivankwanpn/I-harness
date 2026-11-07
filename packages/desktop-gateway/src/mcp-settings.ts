import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import { createMcpConfigStore, type McpSecretPatch, type PublicMcpConfig } from "@i-harness/mcp-client/config"
export type McpSettingsCommand = { action: "save"; config: PublicMcpConfig; secrets?: McpSecretPatch; revision: number } | { action: "enable" | "disable" | "remove"; name: string }
export function createDesktopMcp(path: string) {
  const store = createMcpConfigStore(path)
  let apply: (() => Promise<void>) | undefined
  let applyError: string | undefined
  const scopes=new AsyncLocalStorage<{token?:object;active:boolean}>(),mutations=new Set<object>()
  const assertMutation=()=>{const scope=scopes.getStore();if([...mutations].some(token=>!scope?.active||scope.token!==token))throw Error('MCP mutation pending')}
  const fingerprint=()=>{try{return createHash('sha256').update(readFileSync(path)).digest('hex')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error}}
  const state = async () => ({ servers: await store.list(), ...(applyError ? { applyError } : {}) })
  // Serialize live application: a save immediately followed by an enable used
  // to overlap two plugin refreshes and poison every live session's selection.
  let chain: Promise<void> = Promise.resolve()
  const refresh = async (token?:object) => {
    const wait = chain
    let release!: () => void
    chain = new Promise<void>(resolve => { release = resolve })
    await wait
    const scope={token,active:true}
    try { await scopes.run(scope,async()=>{await apply?.()}); applyError = undefined }
    catch { applyError = "MCP settings were saved, but live application failed. Retry after checking the server configuration."; throw new Error(applyError) }
    finally{scope.active=false;release()}
    return state()
  }
  return {
    state, refresh:()=>refresh(),
    active: store.active,
    async activeWitness(){assertMutation();const before=fingerprint(),configs=await store.active(),after=fingerprint();assertMutation();if(before!==after)throw Error('MCP settings changed during selection');const snapshot=JSON.stringify(configs);return Object.freeze({configs,assertCurrent(){assertMutation();if(fingerprint()!==after||JSON.stringify(configs)!==snapshot)throw Error('MCP settings changed after selection')}})},
    bindRefresh(callback: () => Promise<void>) { apply = callback },
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP settings command")
      const command = value as Record<string, unknown>,token={};mutations.add(token)
      try {
        if (command.action === "save") {
          if (!Number.isSafeInteger(command.revision) || (command.revision as number) < 0) throw new Error("MCP revision required")
          await store.save(command.config, command.secrets as McpSecretPatch | undefined, command.revision as number)
        } else {
          if (typeof command.name !== "string" || !command.name || command.name.length > 64) throw new Error("Invalid MCP server name")
          if (command.action === "remove") await store.remove(command.name)
          else if (command.action === "enable" || command.action === "disable") await store.setEnabled(command.name, command.action === "enable")
          else throw new Error("Unknown MCP operation")
        }
        try { return await refresh(token) } catch { return state() }
      } finally {mutations.delete(token)}
    },
  }
}
