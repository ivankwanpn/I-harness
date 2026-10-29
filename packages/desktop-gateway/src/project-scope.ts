import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import { captureBootstrapTargetPreparationRequest, type BootstrapTargetPreparationRequest, type BootstrapTargetPreparationOutcome } from '@i-harness/session-persistence'
import { isStrictFactData, canonicalJsonData } from '@i-harness/core-session'
import type { SessionProjectContext } from "@i-harness/session-executor"
import type { AuthorityState } from "@i-harness/sandbox"
import { createSessionManagementFence, type SessionManagementFence } from "./session-management-fence.ts"
import { captureBootstrapProject, type BootstrapProjectCapture, type BootstrapProjectPreparation, type BootstrapTargetScope } from './bootstrap-project.ts'
import type { BindingObservations } from '../../session-persistence/src/coordinator/binding-observation.ts'
export type { BootstrapProjectCapture, BootstrapProjectPreparation, BootstrapTargetScope } from './bootstrap-project.ts'
export interface ProjectMoveOptions { assertIdle?(id: string): Promise<void>; drainSession?(id: string): Promise<void>; authorityChanged?(ids: readonly string[]): Promise<void>; fence?: SessionManagementFence }

interface Binding { bound: boolean; projectId?: string }
interface ConfirmedProjectScope { id: string; name: string; roots: string[]; primaryRoot?: string; unavailableReason?: string }
class ProjectFoldersUnavailable extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid project or session ID")
  return value
}
async function directory(value: unknown, field: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`Project ${field} must be absolute directory paths`)
  try {
    const path = await realpath(value)
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory")
    return path
  } catch { throw new ProjectFoldersUnavailable(`Project ${field} must refer to an existing directory`) }
}

/** Session documents identify owners; only this process's main-confirmed
 * catalog supplies roots. Reopening a session never restores saved authority. */
export function createProjectScopeBroker(coordinator: SessionCoordinator, _workspace: string, visible: (id: string, meta: SessionMeta) => Promise<boolean> = async () => true, moveOptions: ProjectMoveOptions = {}) {
  const fence = moveOptions.fence ?? createSessionManagementFence()
  const projects = new Map<string, ConfirmedProjectScope>()
  const bindings = new Map<string, Binding>()
  const parents = new Map<string, string>()
  const loading = new Map<string, Promise<Binding>>()
  const operations = new Map<string, Promise<unknown>>()
  const revisions = new Map<string, number>()
  const bindingRevisions = new Map<string, number>()
  let referenceRevision = 0
  let references: readonly string[] = []
  let referenceFailure: string | undefined
  const observed = new Set<string>()
  const pendingChanges = new Set<string>()
  const scopeUpdates = new Map<string, number>()
  const retainedSources = new Set<{ ids:Set<string>;revoke():void }>()
  const invalidateRetained = (ids?:readonly string[]) => { for (const source of [...retainedSources]) if(!ids||ids.some(id=>source.ids.has(id)))source.revoke() }
  let referenceUpdates = 0
  function trackScopes<T>(ids: readonly string[], job: Promise<T>): Promise<T> {
    invalidateRetained()
    for (const id of ids) scopeUpdates.set(id, (scopeUpdates.get(id) ?? 0) + 1)
    return job.finally(() => { for (const id of ids) { const count = scopeUpdates.get(id)! - 1; if (count) scopeUpdates.set(id, count); else scopeUpdates.delete(id) } })
  }
  const withdrawn = new Set<string>()
  const requests = new Map<string, number>()
  const nextRequest = (id: string) => { const next = (requests.get(id) ?? 0) + 1; requests.set(id, next); return next }
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closed) throw new Error("Project scope broker is closed") }
  let catalogTail: Promise<unknown> = Promise.resolve()
  function catalog<T>(work: () => Promise<T>): Promise<T> {
    const job = catalogTail.catch(() => undefined).then(() => { assertOpen(); return work() })
    catalogTail = job
    return job
  }
  const key = (id: string) => `desktop-session-project-${createHash("sha256").update(id).digest("hex")}`
  async function ensureVisible(id: string): Promise<SessionMeta> {
    assertOpen()
    identifier(id)
    const { meta } = await coordinator.profile(id)
    if (!await visible(id, meta)) throw new Error("Session is unavailable")
    return meta
  }
  function load(id: string): Promise<Binding> {
    const saved = bindings.get(id)
    if (saved) return Promise.resolve(saved)
    const pending = loading.get(id)
    if (pending) return pending
    const job = coordinator.getDocument(key(id)).then((document): Binding => {
      const value = parseBinding(document)
      bindings.set(id, value)
      return value
    }).finally(() => { loading.delete(id) })
    loading.set(id, job)
    return job
  }
  function parseBinding(document: unknown): Binding {
    if (document === undefined) return { bound: false }
    if (!object(document) || !isStrictFactData(document) || document.version !== 1
      || Object.getOwnPropertyNames(document).some(field => !['version', 'projectId'].includes(field))
      || Object.values(Object.getOwnPropertyDescriptors(document)).some(field => !field.enumerable || field.value === undefined)) throw new Error('Invalid session project binding')
    return { bound: true, ...(Object.hasOwn(document, 'projectId') ? { projectId: identifier(document.projectId) } : {}) }
  }
  function observeBinding(id: string, value: Binding) {
    if (canonicalJsonData(bindings.get(id)) !== canonicalJsonData(value)) { invalidateRetained([id]); bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1) }
    bindings.set(id, value)
  }
  function serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    invalidateRetained([id])
    const job = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    operations.set(id, job)
    void job.finally(() => { if (operations.get(id) === job) operations.delete(id) }).catch(() => undefined)
    return job
  }
  async function save(id: string, projectId?: string): Promise<void> {
    assertOpen()
    bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1)
    const document = { version: 1, ...(projectId ? { projectId } : {}) }
    await coordinator.putDocument(key(id), document)
    // Coordinator background document errors are reported rather than thrown.
    // Readback is the commit check before exposing or acknowledging ownership.
    const saved = await coordinator.getDocument(key(id))
    const confirmed = parseBinding(saved)
    if (!confirmed.bound || confirmed.projectId !== projectId) throw new Error("Could not persist session project binding")
    bindings.set(id, { bound: true, ...(projectId ? { projectId } : {}) })
  }
  async function resolveOwner(id: string, ownedOperation?: string, reading = false): Promise<Binding> {
    const chain: string[] = []
    const visited = new Set<string>()
    let cursor = id
    for (;;) {
      if (visited.has(cursor) || chain.length >= 32) throw new Error("Invalid or excessive session project lineage")
      visited.add(cursor); chain.push(cursor)
      const meta = await ensureVisible(cursor)
      if (reading && meta.archived) throw new Error('Result source session archived')
      if ((await load(cursor)).bound) break
      if (!meta.parentSession || (meta.origin !== "subagent" && meta.origin !== "team")) { parents.delete(cursor); break }
      const parent = identifier(meta.parentSession)
      parents.set(cursor, parent)
      cursor = parent
    }
    // Validate the complete chain before waiting: cyclic metadata must not
    // cause two pending binds to wait on each other indefinitely.
    await Promise.all(chain.filter((sessionId) => sessionId !== ownedOperation).map((sessionId) => operations.get(sessionId)))
    return chain.map((sessionId) => bindings.get(sessionId)).find((binding) => binding?.bound) ?? { bound: false }
  }
  function liveOwner(id: string): string | undefined {
    const visited = new Set<string>()
    let cursor: string | undefined = id
    while (cursor) {
      if (visited.has(cursor) || visited.size >= 32) return undefined
      visited.add(cursor)
      const own = bindings.get(cursor)
      if (own?.bound) return own.projectId
      cursor = parents.get(cursor)
    }
    return undefined
  }
  async function projectFor(id: string): Promise<string | undefined> {
    return (await resolveOwner(id)).projectId
  }
  async function observedResultGetter(id:string,captured:BindingObservation) {
    await resolveOwner(id,undefined,true);captured.assertCurrent();observed.add(id)
    const get=()=>{captured.assertCurrent();const projectId=liveOwner(id),context=projectId?projects.get(projectId):undefined;return {...(projectId?{projectId}:{}),...(context?{scope:{id:context.id,name:context.name,primaryRoot:context.primaryRoot!,roots:[...context.roots]}}:{}),revision:`${authority(id).revision}:binding:${bindingRevisions.get(id)??0}`}}
    get();return get
  }
  function scopeSchema(value: unknown): ConfirmedProjectScope {
    if (!object(value)) throw new Error("Invalid project scope")
    const id = identifier(value.id)
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error("Invalid project name")
    if (!Array.isArray(value.roots) || value.roots.length > 100) throw new Error("Project roots must contain existing absolute directories")
    if (value.roots.length === 0) {
      if (value.primaryRoot !== undefined) throw new Error("An empty project cannot have a primary root")
      return { id, name: value.name.trim(), roots: [] }
    }
    if (value.roots.some((root) => typeof root !== "string" || !isAbsolute(root))) throw new Error("Project roots must be absolute directory paths")
    const roots = value.roots as string[]
    if (new Set(roots.map((root) => pathKey(resolve(root)))).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    if (typeof value.primaryRoot !== "string" || !isAbsolute(value.primaryRoot)
      || !roots.some((root) => pathKey(resolve(root)) === pathKey(resolve(value.primaryRoot as string)))) throw new Error("Project primary root must be an absolute project member")
    return { id, name: value.name.trim(), roots: [...roots], primaryRoot: value.primaryRoot }
  }
  async function resolveScope(scope: ConfirmedProjectScope): Promise<ConfirmedProjectScope> {
    if (scope.roots.length === 0) return scope
    const roots = await Promise.all(scope.roots.map((root) => directory(root, "roots")))
    if (new Set(roots.map(pathKey)).size !== roots.length) throw new Error("Project roots contain duplicate directories")
    const primaryIndex = scope.roots.findIndex((root) => pathKey(resolve(root)) === pathKey(resolve(scope.primaryRoot!)))
    return { ...scope, roots, primaryRoot: roots[primaryIndex]! }
  }
  function blocked(scope: ConfirmedProjectScope): ConfirmedProjectScope {
    return { id: scope.id, name: scope.name, roots: [], unavailableReason: "Project folders are unavailable" }
  }
  function assertAvailable(projectId?: string): void {
    const context = projectId ? projects.get(projectId) : undefined
    if (projectId && (!context || withdrawn.has(projectId))) throw new Error("Project authority revoked: catalog entry missing")
    if (context?.unavailableReason) throw new Error(context.unavailableReason)
    if (context && (context.roots.length === 0 || context.primaryRoot === undefined)) throw new Error("Project has no workspace folders")
  }
  function authority(id: string): AuthorityState {
    const projectId = liveOwner(id)
    const revision = `${projectId ?? "unbound"}:${revisions.get(projectId ?? "") ?? 0}:refs:${referenceRevision}`
    if (closed) return { kind: "unavailable", revision, reason: "Project scope service closed" }
    if (referenceFailure) return { kind: "unavailable", revision, reason: referenceFailure }
    if (!bindings.has(id)) return { kind: "unavailable", revision, reason: "Session authority not loaded" }
    if (!projectId) return { kind: "unbound", revision, workspaceRoot: _workspace, references: [...references] }
    const scope = projects.get(projectId)
    if (!scope || withdrawn.has(projectId)) return { kind: "revoked", revision, reason: "Project authority revoked: catalog entry missing" }
    if (scope.unavailableReason || !scope.primaryRoot || !scope.roots.length) return { kind: "unavailable", revision, reason: scope.unavailableReason ?? "Project has no workspace folders" }
    return { kind: "bound", revision, primaryRoot: scope.primaryRoot, roots: [...scope.roots], references: [...references] }
  }
  async function changed(projectIds: readonly string[], publish = true): Promise<void> {
    if(projectIds.length)invalidateRetained()
    for (const id of projectIds) {
      if (publish) revisions.set(id, (revisions.get(id) ?? 0) + 1)
      pendingChanges.add(id)
    }
    const ids = [...observed].filter(id => projectIds.includes(liveOwner(id) ?? ""))
    if (ids.length) await moveOptions.authorityChanged?.(ids)
    for (const id of projectIds) pendingChanges.delete(id)
  }
  return {
    async retainSelectedBindingRead(sessionIds:readonly string[],binding:Awaited<ReturnType<BindingObservations['acquireSelectedBindingRead']>>,sourceId:string) {
      assertOpen();binding.assertCurrent()
      if(!sessionIds.length||sessionIds.length>32||new Set(sessionIds).size!==sessionIds.length||!sessionIds.includes(sourceId))throw Error('Invalid held project lineage')
      const ids=new Set(sessionIds.map(identifier)),observation=binding.observation
      let active=true,uses=0,drain=Promise.withResolvers<void>(),dependent:{revoke():void;close():Promise<void>}|undefined,used=false
      const revoke=()=>{active=false;dependent?.revoke()}
      const item={ids,revoke:()=>binding.revoke()}
      const dependency={revoke,async close(){revoke();if(uses)await drain.promise;if(dependent)await dependent.close();retainedSources.delete(item)}}
      try {
        binding.installRetirementDependency(dependency)
        for(const id of ids){if(operations.has(id)||loading.has(id))throw Error('Project binding operation pending');const meta=observation.metadata(id),doc=observation.binding(id),value=parseBinding(doc.kind==='present'?doc.value:undefined);observeBinding(id,value);if(!value.bound&&meta.parentSession&&['subagent','team'].includes(meta.origin??''))parents.set(id,identifier(meta.parentSession));else parents.delete(id)}
        retainedSources.add(item)
        const stamp=()=>canonicalJsonData([...ids].map(id=>[id,bindingRevisions.get(id)??0,authority(id).revision,liveOwner(id)??null])),original=stamp()
        const assertCurrent=()=>{assertOpen();binding.assertCurrent();if(!active||original!==stamp())throw Error('Project binding observation changed');for(const id of ids){if(operations.has(id)||loading.has(id))throw Error('Project binding operation pending');const projectId=liveOwner(id);if(referenceFailure||referenceUpdates||scopeUpdates.has(projectId??'')||pendingChanges.has(projectId??''))throw Error('Project scope changed');assertAvailable(projectId)}}
        const captured:BindingObservation={ids,observation,assertCurrent}
        let setupEntered=true
        const setupEntry:BindingObservation={ids,observation,assertCurrent(){if(!setupEntered)throw Error('Project observation expired');assertCurrent()}}
        // Setup is original binding work too: revocation joins this acquisition
        // before calling our dependency close or releasing its locks and pins.
        // Its ALS entry expires independently of the original lifetime capture
        // retained by the getter, on successful setup and before failed cleanup.
        let getter:Awaited<ReturnType<typeof observedResultGetter>>
        try {getter=await binding.use(()=>bindingObservations.run([...(bindingObservations.getStore()??[]),setupEntry],async()=>{assertCurrent();for(const id of ids)await ensureVisible(id);return observedResultGetter(sourceId,captured)}))}
        finally {setupEntered=false}
        assertCurrent();getter()
        return Object.freeze({sourceGetter:getter,assertCurrent,attachResult(result:{revoke():void;close():Promise<void>}){assertCurrent();if(used||dependent)throw Error('Result dependency already bound');dependent=result},async use<T>(work:()=>Promise<T>){assertCurrent();used=true;uses++;let entered=true;const entry:BindingObservation={ids,observation,assertCurrent(){if(!entered)throw Error('Project observation expired');assertCurrent()}};try{return await binding.use(()=>bindingObservations.run([...(bindingObservations.getStore()??[]),entry],async()=>{assertCurrent();const value=await work();assertCurrent();return value}))}finally{entered=false;if(!--uses){drain.resolve();drain=Promise.withResolvers<void>()}}},revoke:()=>binding.revoke(),close:()=>binding.release()})
      }catch(error){binding.revoke();try{await binding.release()}catch(cleanup){throw cleanup}throw error}
    },
    prepareBootstrapInheritance(input: BootstrapProjectCapture): BootstrapProjectPreparation {
      const capture = captureBootstrapProject(input), id = capture.invocation.targetSessionId
      const projectId = capture.requestIntent.project.kind === 'project' ? capture.requestIntent.project.projectId : undefined
      let active = true, targetBaseline: string | undefined, sourceBaseline: string | undefined, attemptEpoch: string | undefined
      const fail = (reason: 'unknown'|'unavailable'|'conflict'|'policy'): never => { throw Object.assign(new Error('Bootstrap project ' + reason), { bootstrapReason: reason }) }
      const lifetime = () => { assertOpen(); if (!active || !capture.targetAvailable()) { active = false; fail('unavailable') } }
      const epoch = () => `${projectId ?? 'unassigned'}:${revisions.get(projectId ?? '') ?? 0}:refs:${referenceRevision}`
      const available = () => {
        lifetime()
        if (attemptEpoch !== undefined && attemptEpoch !== epoch()) { active = false; fail('policy') }
        if (referenceFailure || referenceUpdates || scopeUpdates.has(projectId ?? '') || pendingChanges.has(projectId ?? '')) fail('policy')
        assertAvailable(projectId)
      }
      const targetRevision = () => `${epoch()}:binding:${bindingRevisions.get(id) ?? 0}`
      const assertTargetCurrent = () => {
        available()
        if (!bindings.get(id)?.bound || bindings.get(id)?.projectId !== projectId || targetBaseline === undefined || targetBaseline !== targetRevision()) fail('policy')
      }
      const sourceRevision = () => {
        if (!capture.sourceSessionId) return epoch() + ':explicit-import'
        const chain: string[] = [], seen = new Set<string>()
        let cursor: string | undefined = capture.sourceSessionId
        while (cursor) {
          if (seen.has(cursor) || seen.size >= 32 || !bindings.has(cursor)) fail('policy')
          seen.add(cursor); chain.push(`${cursor}:${bindingRevisions.get(cursor) ?? 0}:${canonicalJsonData(bindings.get(cursor))}`)
          if (bindings.get(cursor)?.bound) break
          cursor = parents.get(cursor)
        }
        if (liveOwner(capture.sourceSessionId) !== projectId) fail('policy')
        return epoch() + ':' + canonicalJsonData(chain)
      }
      const newWork = (current: () => boolean) => {
        available()
        if (!capture.sourceAvailable() || !current()) fail('policy')
        capture.assertNewWorkCurrent()
      }
      const assertSourceCurrent = () => {
        newWork(() => true)
        if (sourceBaseline === undefined || sourceBaseline !== sourceRevision()) fail('policy')
      }
      async function readTargetBinding(): Promise<Binding> {
        try { return parseBinding(await coordinator.getDocument(key(id))) }
        catch (error) {
          // A previously acquired getter cannot survive an observation that
          // its durable authority is no longer verifiable. Initial uncertain
          // saves remain recoverable by exact passive readback.
          if (targetBaseline !== undefined) active = false
          throw error
        }
      }
      async function prepare(value: BootstrapTargetPreparationRequest, passive: boolean, current: () => boolean): Promise<BootstrapTargetPreparationOutcome> {
        let request: BootstrapTargetPreparationRequest
        try {
          request = captureBootstrapTargetPreparationRequest(value)
          if (canonicalJsonData(request.invocation) !== canonicalJsonData(capture.invocation)) return { kind: 'blocked', reason: 'conflict' }
        } catch { return { kind: 'blocked', reason: 'conflict' } }
        return serial(id, async () => {
          try {
            available()
            attemptEpoch ??= epoch()
            if (targetBaseline !== undefined) assertTargetCurrent()
            const generation = epoch()
            const check = () => { available(); if (generation !== epoch()) fail('policy'); if (!passive) { newWork(current); if (sourceBaseline !== undefined && sourceBaseline !== sourceRevision()) fail('policy') } }
            check()
            const inspection = await coordinator.inspectBootstrap(capture.invocation)
            check()
            if (!['reserved', 'ready'].includes(inspection.kind) || !inspection.token || !('manifestDigest' in inspection.token) || inspection.token.manifestDigest !== request.manifestDigest
              || canonicalJsonData(inspection.invocation) !== canonicalJsonData(capture.invocation)) fail('conflict')
            if (!passive) {
              if (capture.sourceSessionId) { await resolveOwner(capture.sourceSessionId, undefined, true); check() }
              const revision = sourceRevision()
              if (sourceBaseline !== undefined && sourceBaseline !== revision) fail('policy')
              sourceBaseline ??= revision
              assertSourceCurrent()
            }
            await loading.get(id); check()
            // Always refresh durable identity: an earlier save may have landed
            // even though its response/readback did not confirm it.
            const own = await readTargetBinding(); check()
            observeBinding(id, own)
            if (own.bound && own.projectId !== projectId) fail('conflict')
            if (!own.bound) {
              if (passive || targetBaseline !== undefined) fail('unavailable')
              check()
              bindingRevisions.set(id, (bindingRevisions.get(id) ?? 0) + 1)
              await coordinator.putDocument(key(id), { version: 1, ...(projectId ? { projectId } : {}) }); check()
              const saved = await readTargetBinding(); check()
              if (!saved.bound || saved.projectId !== projectId) fail('unavailable')
              observeBinding(id, saved)
            }
            observed.add(id)
            if (projectId) {
              const declared = projects.get(projectId)!
              // Do not enter catalog(): its invalidation drain may itself be
              // waiting for this admitted bootstrap to finish.
              let resolved: ConfirmedProjectScope
              try { resolved = await resolveScope(declared) }
              catch (error) { if (targetBaseline !== undefined) active = false; throw error }
              check()
              if (canonicalJsonData(resolved) !== canonicalJsonData(projects.get(projectId))) { if (targetBaseline !== undefined) active = false; fail('policy') }
            }
            check()
            targetBaseline ??= targetRevision()
            assertTargetCurrent()
            return { kind: 'confirmed' }
          } catch (error) {
            return { kind: 'blocked', reason: (error as { bootstrapReason?: 'unknown'|'unavailable'|'conflict'|'policy' }).bootstrapReason ?? 'unavailable' }
          }
        })
      }
      return {
        targetPreparation: Object.freeze({ confirm: (request: BootstrapTargetPreparationRequest, current: () => boolean) => prepare(request, false, current), reconcile: (request: BootstrapTargetPreparationRequest) => prepare(request, true, () => true), assertTargetCurrent }),
        targetScope(): BootstrapTargetScope {
          assertTargetCurrent()
          const scope = projectId ? projects.get(projectId)! : undefined
          return { ...(projectId ? { projectId } : {}), ...(scope ? { scope: { id: scope.id, name: scope.name, roots: [...scope.roots], primaryRoot: scope.primaryRoot! } } : {}), revision: targetBaseline! }
        },
        assertSourceCurrent,
        close() { active = false },
      }
    },
    async authorityFor(id: string): Promise<() => AuthorityState> {
      await resolveOwner(id)
      observed.add(id)
      return () => authority(id)
    },
    /** Host-confirmed source registrations impose restrictions only. */
    configureReferences(paths: readonly string[]): Promise<void> {
      invalidateRetained()
      const requested = [...paths]
      referenceRevision++
      referenceUpdates++
      const initialFence = observed.size ? moveOptions.authorityChanged?.([...observed]) ?? Promise.resolve() : Promise.resolve()
      void initialFence.catch(() => {})
      return catalog(async () => {
        await initialFence
        let confirmed: string[]
        try {
          confirmed = await Promise.all(requested.map(async path => {
            if (!isAbsolute(path)) throw new Error("Reference root must be absolute")
            return realpath(path)
          }))
        } catch (error) {
          referenceFailure = "Readonly reference registration unavailable"
          referenceRevision++
          if (observed.size) await moveOptions.authorityChanged?.([...observed])
          throw error
        }
        referenceFailure = undefined
        references = Object.freeze([...new Set(confirmed)])
        referenceRevision++
        if (observed.size) await moveOptions.authorityChanged?.([...observed])
      }).finally(() => { referenceUpdates-- })
    },
    configure(value: unknown): Promise<{ projectId: string }> {
      const snapshot = structuredClone(value)
      let declared: ConfirmedProjectScope
      try { declared = scopeSchema(snapshot) } catch (error) { return Promise.reject(error) }
      const request = nextRequest(declared.id)
      // Publish the admission generation before canonicalization or queued work.
      const initialFence = changed([declared.id])
      void initialFence.catch(() => {})
      return trackScopes([declared.id], catalog(async () => {
        await initialFence
        try {
          const project = await resolveScope(declared)
          assertOpen()
          const publish = JSON.stringify(projects.get(project.id)) !== JSON.stringify(project)
          projects.set(project.id, project)
          if (requests.get(project.id) === request) withdrawn.delete(project.id)
          await changed([project.id], publish)
          return { projectId: project.id }
        } catch (error) {
          if (error instanceof ProjectFoldersUnavailable) { assertOpen(); projects.set(declared.id, blocked(declared)); await changed([declared.id]) }
          throw error
        }
      }))
    },
    sync(value: unknown): Promise<{ synchronized: true }> {
      const snapshot = structuredClone(value)
      let declarations: ConfirmedProjectScope[]
      try {
        if (!Array.isArray(snapshot) || snapshot.length > 2048) throw new Error("Invalid project scope catalog")
        declarations = snapshot.map(scopeSchema)
        if (new Set(declarations.map(project => project.id)).size !== declarations.length) throw new Error("Project scope catalog contains duplicate IDs")
      } catch (error) { return Promise.reject(error) }
      const declaredIds = new Set(declarations.map(project => project.id))
      const removed = [...projects.keys()].filter(id => !declaredIds.has(id))
      for (const id of removed) { withdrawn.add(id); nextRequest(id) }
      const requestIds = new Map(declarations.map(project => [project.id, nextRequest(project.id)]))
      const initialIds = [...removed, ...declarations.filter(project => withdrawn.has(project.id) || JSON.stringify(projects.get(project.id)) !== JSON.stringify(project)).map(project => project.id)]
      const initialFence = changed(initialIds)
      void initialFence.catch(() => {})
      return trackScopes([...declaredIds], catalog(async () => {
        await initialFence
        const confirmed = await Promise.all(declarations.map(async (project) => {
          try { return await resolveScope(project) }
          catch (error) { if (error instanceof ProjectFoldersUnavailable) return blocked(project); throw error }
        }))
        assertOpen()
        const next = new Map(confirmed.map(project => [project.id, project]))
        const affected = [...new Set([...projects.keys(), ...next.keys()])].filter(id => JSON.stringify(projects.get(id)) !== JSON.stringify(next.get(id)))
        const retries = [...pendingChanges].filter(id => !affected.includes(id))
        projects.clear()
        for (const project of confirmed) {
          projects.set(project.id, project)
          if (requests.get(project.id) === requestIds.get(project.id)) withdrawn.delete(project.id)
        }
        await changed(affected)
        await changed(retries, false)
        return { synchronized: true as const }
      }))
    },
    revoke(projectId: string): Promise<{ revoked: boolean }> {
      try { identifier(projectId) } catch (error) { return Promise.reject(error) }
      const revoked = projects.has(projectId) && !withdrawn.has(projectId)
      nextRequest(projectId); withdrawn.add(projectId)
      const drain = changed([projectId])
      void drain.catch(() => {})
      return catalog(async () => { await drain; projects.delete(projectId); return { revoked } })
    },
    bind(id: string, projectId?: string): Promise<{ sessionId: string; projectId?: string }> {
      return serial(id, async () => {
        await ensureVisible(id)
        if (projectId !== undefined) identifier(projectId)
        const own = await load(id)
        const existing = await resolveOwner(id, id)
        if (existing.bound) {
          if (projectId !== undefined && existing.projectId !== projectId) throw new Error("Session already belongs to another project; an explicit move is required")
          assertAvailable(existing.projectId)
          if (!own.bound) await save(id, existing.projectId)
          return { sessionId: id, ...(existing.projectId ? { projectId: existing.projectId } : {}) }
        }
        if (projectId !== undefined && !projects.has(projectId)) throw new Error("Project scope has not been confirmed by the current main process")
        assertAvailable(projectId)
        await save(id, projectId)
        return { sessionId: id, ...(projectId ? { projectId } : {}) }
      })
    },
    projectFor,
    /** Only a target's own durable binding can avoid ancestor traversal. */
    async resultReadScopeFor(id: string): Promise<(() => import('@i-harness/session-executor').ResultReadScope) | undefined> {
      const captured = currentObservation(id)
      if (captured) {
        return observedResultGetter(id,captured)
      }
      const meta = await ensureVisible(id)
      if (meta.archived) throw new Error('Session is archived')
      await operations.get(id)
      const own = await load(id)
      assertOpen()
      if (!own.bound) return undefined
      observed.add(id)
      const get = () => {
        assertOpen()
        if (!bindings.get(id)?.bound) throw new Error('Result read binding unavailable')
        const projectId = bindings.get(id)!.projectId
        assertAvailable(projectId)
        const context = projectId ? projects.get(projectId) : undefined
        return { ...(projectId ? { projectId } : {}), ...(context ? { scope: { id: context.id, name: context.name, primaryRoot: context.primaryRoot!, roots: [...context.roots] } } : {}),
          revision: `${bindingRevisions.get(id) ?? 0}:${projectId ?? 'unbound'}:${revisions.get(projectId ?? '') ?? 0}` }
      }
      get()
      return get
    },
    async nativeScopeFor(id:string):Promise<{projectId?:string;scope?:SessionProjectContext;revision:string}> {
      await resolveOwner(id, undefined, true)
      assertOpen()
      const projectId=liveOwner(id)
      const revision = authority(id).revision + ':binding:' + (bindingRevisions.get(id) ?? 0)
      if(!projectId)return {revision}
      const context=projects.get(projectId)
      if(!context)return {projectId,revision}
      assertAvailable(projectId)
      return {projectId,revision,scope:{id:context.id,name:context.name,roots:[...context.roots],primaryRoot:context.primaryRoot!}}
    },
    move(id: string, expectedOwner: string | undefined, projectId: string | undefined): Promise<{ sessionId: string; projectId?: string; executionWorkspace: string }> {
      return fence.exclusive(id, () => serial(id, async () => {
        const meta = await ensureVisible(id)
        if (meta.origin === "subagent" || meta.origin === "approval-review" || (meta.origin === "team" && meta.parentSession)) throw new Error("Session is unavailable for project move")
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        if (expectedOwner !== undefined) identifier(expectedOwner)
        if (projectId !== undefined) identifier(projectId)
        // A reader pin holds the native lock without adopting a live writer.
        const alreadyOwned = coordinator.hasLiveOwnership?.(id) ?? coordinator.ownerOf(id)
        await coordinator.adoptOwnership(id)
        try {
        // A second broker/process may have committed ownership since this
        // broker last resolved it. Compare durable identity under the lease.
        await loading.get(id)
        bindings.delete(id)
        const current = await resolveOwner(id, id)
        if (current.projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
        for (const child of await coordinator.list()) if ((await coordinator.profile(child)).meta.parentSession === id) throw new Error("Session has descendants; coordinated project move is unavailable")
        await catalog(async () => {
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            projects.set(projectId, await resolveScope(declared))
            assertAvailable(projectId)
          }
        })
        await moveOptions.assertIdle(id)
        await moveOptions.drainSession?.(id)
        await moveOptions.assertIdle(id)
        await catalog(async () => {
          await loading.get(id)
          bindings.delete(id)
          if ((await resolveOwner(id, id)).projectId !== expectedOwner) throw new Error("Session project owner changed; refresh before moving")
          if (projectId !== undefined) {
            const declared = projects.get(projectId)
            if (!declared) throw new Error("Destination project has not been confirmed by the current main process")
            const scope = await resolveScope(declared)
            projects.set(projectId, scope)
            assertAvailable(projectId)
          }
          await save(id, projectId)
        })
        return { sessionId: id, ...(projectId ? { projectId } : {}), executionWorkspace: _workspace }
        } finally { if (!alreadyOwned) await coordinator.releaseOwnership(id) }
      }), async () => {
        if (!moveOptions.assertIdle) throw new Error("Idle project move inspection is unavailable")
        await moveOptions.assertIdle(id)
      })
    },
    async state(id: string): Promise<{ sessionId: string; projectId?: string }> {
      const projectId = await projectFor(id)
      return { sessionId: id, ...(projectId ? { projectId } : {}) }
    },
    async forSession(id: string): Promise<() => SessionProjectContext | undefined> {
      await resolveOwner(id)
      observed.add(id)
      return () => {
        const state = authority(id)
        if (state.kind === "revoked" || state.kind === "unavailable") throw new Error(state.reason)
        const projectId = liveOwner(id)
        const context = projectId ? projects.get(projectId) : undefined
        if (!context) return undefined
        assertAvailable(projectId)
        return { id: context.id, name: context.name, primaryRoot: context.primaryRoot!, roots: [...context.roots] }
      }
    },
    inherit(sourceId: string, childId: string): Promise<void> {
      return serial(childId, async () => {
        await ensureVisible(childId)
        const projectId = await projectFor(sourceId)
        const existing = await load(childId)
        if (existing.bound) {
          if (existing.projectId !== projectId) throw new Error("Forked session already belongs to another project")
          return
        }
        await save(childId, projectId)
      })
    },
    close(): Promise<void> {
      if (closing) return closing
      invalidateRetained()
      closed = true
      projects.clear()
      closing = Promise.allSettled([catalogTail, ...operations.values(), ...loading.values()]).then(async () => {
        if (observed.size) await moveOptions.authorityChanged?.([...observed])
      }).catch(error => { closing = undefined; throw error })
      return closing
    },
  }
}
