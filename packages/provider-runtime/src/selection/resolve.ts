import { ANTHROPIC_MAX_TOKENS_FALLBACK } from "@i-harness/llm-seam"
import { resolveEffectiveModelContext, type buildModelClient } from "@i-harness/provider"
import type { ProviderAuthResolver, ResolvedProviderAuth } from "@i-harness/credentials"
import type { CreateProviderRuntimeOptions } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"
import { runtimeProfile } from "../directory/profile.ts"
import { authRef, authValue } from "../runtime/auth.ts"
import { validateChatGptRoute } from "../configuration/validation.ts"
import { selectModel, normalizeReasoningEffort, invalidState, errorMessage, PROTOCOL_CHOICES, REASONING_EFFORTS_BY_PROTOCOL } from "./choice.ts"
import { createBindingClient } from "./binding.ts"
import type { ProviderRuntime } from "../types.ts"

export function createModelResolver(
  options: Pick<CreateProviderRuntimeOptions, "settings" | "codex" | "readModelWait" | "readModelRetryLimit">,
  auth: ProviderAuthResolver,
  buildClient: typeof buildModelClient,
  provider: (id: string) => ProviderView | undefined,
): Pick<ProviderRuntime, "resolveModel"> {
  return {
    async resolveModel(input) {
      const selection = selectModel(input, options.settings.get().llm.defaultModel)
      if ("state" in selection) return selection.state

      const { providerId, modelId } = selection
      const view = provider(providerId)
      if (view === undefined) {
        return invalidState(
          `Unknown provider "${providerId}"`,
          providerId,
          modelId,
        )
      }
      // NO MEMBERSHIP CHECK HERE, deliberately, and please do not add one back.
      //
      // There was one: `if (!view.models.some(m => m.id === modelId)) invalid`.
      // It broke on a VENDOR RENAME — `deepseek-flash` is the name DeepSeek's own
      // docs tell you to use, and our table still listed the retired
      // `deepseek-v4-flash` and friends, so the correct name was refused and the
      // obsolete ones were accepted. Measured 2026-09-19.
      //
      // It also bought nothing: every line below tolerates an undeclared model
      // (`userModel?.`, an optional `contextWindow` in the binding), and the one
      // thing a check could have supplied — the model's capacity — is not in the
      // table for this provider anyway (the entries are bare ids), so a DECLARED
      // model resolved no context window either. Six shipping harnesses were read
      // for this; four pass an unknown model through, one probes the provider,
      // and the two that refuse give an actionable message and a documented
      // escape hatch. This gave neither.
      //
      // The line that DOES belong is above: an unknown PROVIDER is still refused,
      // because without its entry there is no base URL and no credential source.
      // `view.models` remains the UI-facing directory — it is a list to choose
      // from, not a licence to run.

      const reasoningEffort = normalizeReasoningEffort(selection.reasoningEffort)
      if (selection.reasoningEffort !== undefined && reasoningEffort === undefined) {
        return invalidState(
          `Invalid reasoning effort "${selection.reasoningEffort}"`,
          providerId,
          modelId,
        )
      }

      try { validateChatGptRoute(view.user ?? {}, selection.protocol ?? view.user?.models?.find(model => model.id === modelId)?.protocol) }
      catch (error) { return invalidState(errorMessage(error), providerId, modelId) }
      if (view.user?.oauthAccountId && !view.models.some(model => model.id === modelId)) return invalidState("Codex subscription model is not in this account's current catalog. Refresh Coding Plans models.", providerId, modelId)
      const ref = authRef(view)
      if (ref === undefined) {
        return {
          status: "unconfigured",
          reason: `No API key configured for provider "${providerId}"`,
        }
      }

      let resolvedAuth: ResolvedProviderAuth | undefined
      try {
        resolvedAuth = await auth.resolve(ref, { providerId, purpose: "inference" })
      } catch (error) {
        return invalidState(
          `Failed to resolve authentication for provider "${providerId}": ${errorMessage(error)}`,
          providerId,
          modelId,
        )
      }
      if (resolvedAuth === undefined) {
        return {
          status: "unconfigured",
          reason: `No API key configured for provider "${providerId}"`,
        }
      }

      let apiKey: string | undefined
      if (resolvedAuth.kind === "ambient") {
        if (view.protocol !== "bedrock" || ref.kind !== "ambient") {
          return invalidState(
            `Ambient authentication is only supported for Bedrock provider "${providerId}"`,
            providerId,
            modelId,
          )
        }
      } else {
        apiKey = authValue(resolvedAuth)
        if (apiKey === undefined) {
          return {
            status: "unconfigured",
            reason: `No usable credential configured for provider "${providerId}"`,
          }
        }
      }

      const userModel = view.user?.models?.find((model) => model.id === modelId)
      // The chain, most specific first: the SELECTION (a session's or a role's),
      // then the model row, then the route — see runtimeProfile.
      const listedModel = view.models.find((model) => model.id === modelId)
      const modelModalities = userModel?.inputModalities ?? listedModel?.inputModalities ?? (listedModel ? view.inputModalities : undefined)
      const profile = runtimeProfile(
        view, apiKey, modelModalities, selection.protocol ?? userModel?.protocol, options.settings.get().modelRetryLimit,
      )
      if (profile && ref.kind === "oauth-account-ref" && options.codex) {
        profile.codexSubscription = true
        profile.baseUrl = "https://chatgpt.com/backend-api/codex"
        profile.resolveCodexAuth = signal => options.codex!.token(ref.accountId, signal)
      }
      if (profile === undefined) {
        // The chain ran out. Name the ROUTE (not the model): the protocol is
        // the route's declaration, and `provider set` is the verb that owns it.
        return invalidState(
          `provider "${providerId}" declares no protocol, so "${modelId}" cannot be sent; set one with: i-harness provider set ${providerId} --protocol ${PROTOCOL_CHOICES}`,
          providerId,
          modelId,
        )
      }
      const effective = resolveEffectiveModelContext({
        profile,
        modelId,
        ...(userModel !== undefined ? { userModel } : {}),
      })
      const contextWindow = effective?.contextWindow
      // M72 Ⅱ: the same resolution already produced the output cap — it was
      // thrown away one line after being computed. Both numbers travel: the
      // window is what the host compacts against, the cap is what the request
      // must actually carry.
      // M72 Ⅲ: Anthropic's Messages API REQUIRES `max_tokens`, so its fallback
      // must be resolved HERE — where the protocol is known — or the value the
      // adapter invents never meets core-agent's clamp (the phase-Ⅱ record's
      // I1: `input 100K + 128000 > 200K` was a 400 on exactly the request that
      // ran because the context was nearly full). With nothing resolved above,
      // this is the value the chain supplies; it travels like any other cap.
      // `profile.protocol` is the ADAPTER spelling (adapterProtocol maps
      // openai-completions → openai-compatible and passes the rest through), so
      // an anthropic route reads exactly as declared.
      const maxOutputTokens = effective?.maxOutputTokens
        ?? (profile.protocol === "anthropic-messages" ? ANTHROPIC_MAX_TOKENS_FALLBACK : undefined)

      try {
        const client = createBindingClient(options, buildClient, profile, view, modelId)
        return {
          status: "ready",
          binding: {
            client,
            providerId,
            modelId,
            // M59 grok parity: the status row wears a HUMAN label —
            // "OpenCode Go · glm-5.3-flash" (provider displayName · model id);
            // the route-scoped `provider:model` string remains the fallback.
            label: view.displayName === "" || view.displayName === providerId
              ? `${providerId}:${modelId}`
              : `${view.displayName} · ${modelId}`,
            protocol: profile.protocol,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            reasoningEfforts: [...REASONING_EFFORTS_BY_PROTOCOL[profile.protocol]],
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(profile.inputModalities?.includes("image") ? { imageInput: true as const } : {}),
          },
        }
      } catch (error) {
        return invalidState(
          `Failed to build model "${providerId}:${modelId}": ${errorMessage(error)}`,
          providerId,
          modelId,
        )
      }
    }
  }
}
