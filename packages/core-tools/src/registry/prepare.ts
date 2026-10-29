import type { PluginContext } from "@i-harness/core-plugin"
import { assertToolSettlementScope, bindPreparedSettlement } from './retained-outcome.ts'
import { registerResultPrepared } from './result-finalization.ts'
import { validateJsonSchemaValue, type JsonSchemaNode } from "../json-schema.ts"
import { ToolArgsError, type ToolCall, type PreparedCall, type ToolExec, type ToolDecision, type PreparedApprovalInput, type ApprovalGuardian, type ToolRegistry } from "../types.ts"
import { freezeArguments } from "../approval/arguments.ts"
import { captureToolCall, ordinaryJson } from '../approval/capture-call.ts'
import { isAbsolute, win32 } from 'node:path'
import { bindNativeExecution, registerCaptureOwner, instructionReplan } from '../instructions.ts'
import type { CapturedToolCall, ToolPrepareIdentity, NativePlan, NativeMutation, AcceptedInstructionCall } from '../types.ts'
import { isDecision, mergeDecision } from "../approval/decision.ts"
import { captureApproval } from "../approval/identity.ts"
import type { createCatalog } from "./catalog.ts"

export function createPreparer(ctx: PluginContext, catalog: Pick<ReturnType<typeof createCatalog>, "captureBinding">, getRegistry: () => ToolRegistry, instructionsRequired = false, verifyOrigin?: (origin: AcceptedInstructionCall, capture: CapturedToolCall) => boolean) {
  type Capture = { call: ToolCall; identity: ToolPrepareIdentity; tool: ReturnType<typeof catalog.captureBinding>['tool']; executeBinding: ReturnType<typeof catalog.captureBinding>['executeBinding']; bindingGeneration: number; bindingValidation: () => boolean; native?: NativePlan; concurrencySafe: boolean; used: boolean; origin?: AcceptedInstructionCall; authority?: NativeMutation }
  const captures = new WeakMap<CapturedToolCall, Capture>()
  const executions = new WeakMap<PreparedCall, () => Promise<unknown>>()
  function invokePrepared(prepared: PreparedCall): Promise<unknown> {
    const invoke = executions.get(prepared)
    if (!invoke) throw new Error('Foreign prepared execution')
    return invoke()
  }
  function owned(handle: CapturedToolCall): Capture {
    const entry = handle && captures.get(handle)
    if (!entry) throw new Error('Foreign tool capture')
    return entry
  }
  function capture(input: ToolCall, identity: ToolPrepareIdentity = {}): CapturedToolCall {
    assertToolSettlementScope(identity.session, identity.settlementSource)
    const call = captureToolCall(input)
    freezeArguments(call)
    const { tool, bindingGeneration, bindingValidation, planBinding, executeBinding } = catalog.captureBinding(call)

    // spec §3.7: BEFORE the policy layers, so a malformed call never reaches an
    // approval prompt — nobody should be asked to approve garbage. The refusal
    // is a TYPED disposition (§3.7.1), read by name at exactly one place.
    const violations = validateJsonSchemaValue(tool.inputSchema as JsonSchemaNode, call.args)
    if (violations.length > 0) throw new ToolArgsError(violations)
    const planMethod = planBinding
    let native: NativePlan | undefined
    if (planMethod) {
      const plan = planMethod.call(tool, call.args)
      if (!ordinaryJson(plan)) throw new TypeError('Native plan must be ordinary JSON data')
      const copied = structuredClone(plan) as NativePlan
      if (!copied || !Array.isArray(copied.targets) || copied.targets.length > 1024 || !Object.hasOwn(copied, 'operation') || copied.targets.some(t => !t || typeof t.path !== 'string' || !(isAbsolute(t.path) || win32.isAbsolute(t.path)) || !['file', 'directory'].includes(t.kind) || !['read', 'mutate'].includes(t.mode))) throw new TypeError('Invalid native plan targets')
      freezeArguments(copied); native = copied
    }
    const handle: CapturedToolCall = Object.freeze({ kind: 'captured-tool-call' })
    captures.set(handle, { call, identity: Object.freeze({ ...identity }), tool, executeBinding, bindingGeneration, bindingValidation, native, concurrencySafe: tool.isConcurrencySafe === true, used: false })
    registerCaptureOwner(handle, getRegistry())
    return handle
  }
  function inspectCapture(handle: CapturedToolCall) {
    const entry = owned(handle)
    return Object.freeze({ call: entry.call, identity: entry.identity, ...(entry.native ? { native: entry.native } : {}), concurrencySafe: entry.concurrencySafe })
  }
  function bindNativeInstructions(handle: CapturedToolCall, origin: AcceptedInstructionCall, authority: NativeMutation) {
    const entry = owned(handle)
    if (entry.used || entry.origin || !entry.native || !origin || !authority) throw new Error('Invalid native instruction binding')
    if (instructionsRequired && (!verifyOrigin || !verifyOrigin(origin, handle))) throw new Error('Foreign accepted instruction origin')
    function bind(name: keyof NativeMutation) {
      for (let current: object | null = authority; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name)
        if (descriptor) {
          if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
          return descriptor.value.bind(authority)
        }
      }
      throw new TypeError(`Invalid native authority ${name}`)
    }
    entry.origin = origin; entry.authority = Object.freeze({ assertCurrent: bind('assertCurrent'), before: bind('before'), settle: bind('settle') })
  }
  async function prepareCaptured(handle: CapturedToolCall, signal?: AbortSignal, origin?: AcceptedInstructionCall): Promise<PreparedCall> {
    const entry = owned(handle)
    if (entry.used) throw new Error('Tool capture already prepared')
    entry.used = true
    if (!entry.bindingValidation()) throw new Error('Captured tool binding changed')
    if (entry.origin !== undefined && entry.origin !== origin) throw new Error('Native instruction origin mismatch')
    if (instructionsRequired && entry.native?.targets.some(t => t.mode === 'mutate') && (!entry.authority || !origin || entry.origin !== origin || !verifyOrigin?.(origin, handle))) throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'missing-origin', currentFingerprint: '' })
    const { call, identity, tool, executeBinding, bindingGeneration, bindingValidation } = entry
    assertToolSettlementScope(identity.session, identity.settlementSource)
    const commandDialect = tool.commandDialect?.(call.args)
    // Policy/hook identity comes only from the trusted host, never model JSON.
    const policyInput = { name: call.name, args: call.args,
      ...(identity?.session !== undefined ? { session: identity.session } : {}),
      ...(identity?.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
      ...(identity?.callId !== undefined ? { callId: identity.callId } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(commandDialect !== undefined ? { dialect: commandDialect } : {}),
    }

    // 1. pre-execute waterfall — resolves to a closed-vocabulary decision.
    //    Per-dispatch (M13): the decision is the emit's chain return (or the
    //    call payload when no decision was produced — see the handler's
    //    CRITICAL comment); no shared slot, so concurrent prepares are
    //    independent.
    const chainValue = await ctx.emit("tools/pre-execute", policyInput)
    const decision: ToolDecision = isDecision(chainValue) ? chainValue : { kind: "allow" }

    // 1b. Cross-scope fail-open fix (Task 10 mechanism B): `emit` propagates
    //     CHILD → PARENT, so a policy mounted on an ancestor scope (e.g.
    //     guard-approval on the parent) runs and may decide, but its decision
    //     never flows BACK DOWN into this registry's own waterfall chain — the
    //     local `decision` would stay "allow" and a dangerous child-scope
    //     dispatch would execute silently. The scope plumbing records ancestor
    //     decisions (plain-listener seeds, nearest-wins) and exposes them via
    //     `ctx.resolveAncestorDecision`; consult it and merge so a stricter
    //     ancestor decision gates this dispatch from any scope in the chain.
    //
    //     M13: the lookup is ANCESTOR-ONLY (`resolveAncestorDecision` skips
    //     self). The self decision is already the per-dispatch `decision` above
    //     (emit's chain return), and core-plugin's per-scope decisions map is a
    //     SHARED slot across concurrent in-flight emits — reading it here would
    //     let one dispatch's decision leak into a concurrent sibling's merge
    //     (the same race the emit-return refactor removes for the closure
    //     slot). Only ancestor decisions cannot be derived from the local emit,
    //     so only they are looked up.
    const ancestorDecision = ctx.resolveAncestorDecision("tools/pre-execute", policyInput)
    const resolved = mergeDecision(decision, ancestorDecision)

    // 2. monotonic guards run UNCONDITIONALLY before any dispatch (audit F03-1):
    //    a decision-shaped object can never short-circuit the guard layer.
    const guardReason = ctx.checkGuards("tools/execute", { name: call.name, args: call.args })
    if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)

    // 3. decision enforcement + approval seam — fail closed: no answerer ⇒ deny.
    if (resolved.kind === "deny") throw new Error(`denied: ${resolved.reason}`)
    const preparedApprovalInput: PreparedApprovalInput = { tool, call, registry: getRegistry(), bindingGeneration, validateBinding: bindingValidation,
      ...(identity?.sessionId !== undefined ? { sessionId: identity.sessionId } : {}) }
    const approval = captureApproval(ctx, preparedApprovalInput, call)
    const authorityValidation = approval.authorityValidation
    if (resolved.kind === "ask") {
      // R-A9 guardian: runtime review before the human approval decision.
      // deny → fail-closed; approve → auto-approve (skip the answerer);
      // allow → human answerer as before. Absent → pre-R-A9 behavior.
      let guardian: ApprovalGuardian | undefined
      try {
        guardian = ctx.services.get<ApprovalGuardian>("approval/guardian")
      } catch {
        guardian = undefined
      }
      if (guardian) {
        const verdict = await guardian({ name: call.name, reason: resolved.reason, args: call.args, ...(identity?.modelGeneration ? { generation: identity.modelGeneration.approval } : {}), ...(signal !== undefined ? { signal } : {}) })
        if (verdict.outcome === "deny") throw new Error(`guardian denied: ${verdict.rationale}`)
        if (verdict.outcome === "allow") await approval.askHuman(resolved.reason)
      } else {
        await approval.askHuman(resolved.reason)
      }
    }

    const approvalValidation = approval.approvalValidation

    // M13: seed the per-dispatch exec with the caller signal so in-flight tool
    // bodies observe a step abort (guard-timeout links its derived controller
    // to this upstream signal; untimed tools honor exec.abortSignal directly).
    // M19 (Ruling 24): optionally seed the executing session identity so the
    // dispatch path can attribute the caller (agent-team resolves team-tool
    // callers from it). Additive: no identity → the exec is exactly as before.
    const exec: ToolExec = {}
    if (identity?.modelGeneration) exec.modelGeneration = identity.modelGeneration
    if (signal) exec.abortSignal = signal
    if (identity?.sessionId !== undefined) exec.sessionId = identity.sessionId
    if (identity?.session !== undefined) exec.session = identity.session
    if (identity?.callId !== undefined) exec.callId = identity.callId
    if (identity?.callEventSeq !== undefined) exec.callEventSeq = identity.callEventSeq
    if (identity?.resultConsumer === "code") exec.resultConsumer = "code"

    const prepared = { call, tool, exec, bindingGeneration, bindingValidation, ...(authorityValidation ? { authorityValidation } : {}), ...(approvalValidation ? { approvalValidation } : {}), ...(commandDialect !== undefined ? { commandDialect } : {}) }
    if (entry.native) {
      const targets = new Set(entry.native.targets.filter(t => t.mode === 'mutate').map(t => t.path))
      const assertCurrent = () => {
        if (!bindingValidation() || authorityValidation?.() === false || approvalValidation?.() === false) throw new Error('Native authority changed')
        const reason = ctx.checkGuards('tools/execute', { name: call.name, args: call.args })
        if (reason !== undefined) throw new Error(`guard denied: ${reason}`)
        entry.authority?.assertCurrent()
        if (instructionsRequired && entry.native!.targets.some(t => t.mode === 'mutate') && (!entry.origin || !verifyOrigin?.(entry.origin, handle))) throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'revoked', currentFingerprint: '' })
      }
      bindNativeExecution(exec, entry.native, Object.freeze({
        assertCurrent,
        before(boundary) { if (!targets.has(boundary.target)) throw new Error('Native boundary outside captured plan'); assertCurrent(); entry.authority?.before(boundary) },
        settle() { entry.authority?.settle() },
      } satisfies NativeMutation))
    }
    bindPreparedSettlement(prepared, identity?.settlementSource)
    registerResultPrepared(prepared, identity?.settlementSource)
    // The callback stays private to this registry; hooks cannot replace the
    // executable, receiver, frozen arguments or exec through prepared metadata.
    executions.set(prepared, () => executeBinding.call(tool, call.args as never, exec))
    return prepared
  }

  return { capture, inspectCapture, bindNativeInstructions, prepareCaptured, invokePrepared }
}
