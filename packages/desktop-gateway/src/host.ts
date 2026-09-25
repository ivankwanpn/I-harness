import { readFile, mkdir } from "node:fs/promises"
import { dirname, join, isAbsolute } from "node:path"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService, type SessionServiceOptions } from "@i-harness/session-executor"
import { createSdkServer } from "@i-harness/sdk/server"
import { resolveSettingsPath, SettingsStore } from "@i-harness/settings"
import type { RpcMessage } from "@i-harness/sdk"
import { createDesktopRouter, createGatewayWrite } from "./router.ts"
import { createInteractionBridge } from "./interaction.ts"
import { createWorkspaceReview } from "./review.ts"
import type { DesktopHandlers, SandboxState } from "./types.ts"

export interface DesktopHostOptions {
  workspace: string
  sessionDir: string
  settingsPath?: string
  credentialsPath?: string
  onWrite: (frame: RpcMessage) => void
}

export interface DesktopHost {
  handleLine(line: string): Promise<void>
  close(): Promise<void>
}

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"])

/** SettingsStore intentionally falls back on corrupt JSON; a host claiming a
 * configured sandbox must distinguish a first run from a damaged document. */
async function validateSettingsDocument(path: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`invalid settings: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("invalid settings: JSON parse failed")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid settings: expected an object")
  }
  const mode = (parsed as { sandboxMode?: unknown }).sandboxMode
  if (mode !== undefined && (typeof mode !== "string" || !SANDBOX_MODES.has(mode))) {
    throw new Error("invalid settings: unknown sandboxMode")
  }
}

export async function createDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  if (!isAbsolute(options.workspace) || !isAbsolute(options.sessionDir)) {
    throw new Error("workspace and sessionDir must be absolute paths")
  }
  const settingsPath = resolveSettingsPath(options.settingsPath === undefined ? {} : { path: options.settingsPath })
  await validateSettingsDocument(settingsPath)
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  const mode = settings.get().sandboxMode
  const sandboxState: SandboxState = { mode, source: "settings", wired: true }
  const credentials = createCredentialStore(options.credentialsPath ?? join(dirname(settingsPath), "credentials.json"))
  const runtime = createProviderRuntime({ settings, credentials })
  await mkdir(options.sessionDir, { recursive: true })
  const coordinator = createSessionCoordinator(createJsonlBackend(options.sessionDir), {
    lock: { enabled: true, lockRoot: options.sessionDir },
  })
  const modelBindingFor: NonNullable<SessionServiceOptions["modelBindingFor"]> = async (_sessionId, meta) => {
    const state = await runtime.resolveModel(meta?.modelSelection === undefined
      ? {}
      : { sessionSelection: meta.modelSelection })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { model: client, ...binding } }
  }
  const service = createSessionService({
    workspace: options.workspace,
    sandbox: mode,
    modelPolicy: "required",
    modelBindingFor,
    coordinator,
    sessionFor: createDurableSessionLoader(coordinator),
    outputSpill: {},
  })
  const interaction = createInteractionBridge(options.onWrite)
  const offInteraction = service.onAssembly((assembly) => interaction.attach(assembly))
  const handlers: DesktopHandlers = {
    sandboxState: () => sandboxState,
    interaction,
    review: createWorkspaceReview(options.workspace),
  }
  const base = createSdkServer(service, {
    coordinator,
    createSession: async () => ({ sessionId: (await coordinator.create()).id }),
    listSessions: async () => {
      const ids = await coordinator.list()
      const sessions = await Promise.all(ids.map(async (id) => {
        try {
          const { meta } = await coordinator.profile(id)
          return { id, ...(meta.title === undefined ? {} : { title: meta.title }) }
        } catch {
          return { id }
        }
      }))
      return { sessions }
    },
    onWrite: createGatewayWrite(options.onWrite, handlers),
  })
  const router = createDesktopRouter(base, options.onWrite, handlers)
  let closing: Promise<void> | undefined
  return {
    handleLine: (line) => router.handleLine(line),
    close: () => closing ??= (async () => {
      interaction.close()
      offInteraction()
      await router.close()
      await service.close()
      await coordinator.close()
    })(),
  }
}
