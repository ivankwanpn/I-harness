import type { ProviderProfile } from "@i-harness/provider"
import { resolveProviderProtocol, type SettingsProviderConfig, type SettingsProviderProtocol, type SettingsInputModality } from "@i-harness/settings"
import type { ProviderView } from "./types.ts"
import { mergeModels } from "./merge.ts"

export function providerView(
  id: string,
  template: ProviderProfile | undefined,
  user: SettingsProviderConfig | undefined,
): ProviderView {
  // The chain ends in ABSENCE when nobody declared one — resolveProviderProtocol
  // has no tail to fall through to, and every reader below must handle the
  // absent case on its own terms.
  const protocol = user?.protocol ?? templateSettingsProtocol(template)
    ?? resolveProviderProtocol(id, user)
  const models = mergeModels(
    template?.models?.map((modelId) => ({ id: modelId })) ?? [],
    user?.models ?? [],
  )
  return {
    id,
    ...(template !== undefined ? { template } : {}),
    ...(user !== undefined ? { user } : {}),
    displayName: user?.displayName ?? template?.displayName ?? id,
    protocol,
    ...(user?.baseURL !== undefined
      ? { baseURL: user.baseURL }
      : template?.baseUrl !== undefined ? { baseURL: template.baseUrl } : {}),
    ...(user?.modelsURL !== undefined ? { modelsURL: user.modelsURL } : {}),
    ...(user?.catalog !== undefined ? { catalog: user.catalog } : {}),
    ...(user?.apiKeyEnv !== undefined
      ? { apiKeyEnv: user.apiKeyEnv }
      : template?.apiKeyEnv !== undefined ? { apiKeyEnv: template.apiKeyEnv } : {}),
    // M59: the user header MAP replaces the template's whole map when set
    // (not a per-key merge — a user map wins wholesale; the adapter/probe then
    // keeps its own auth keys on top).
    ...(user?.headers !== undefined
      ? { headers: user.headers }
      : template?.headers !== undefined ? { headers: template.headers } : {}),
    // M61: content types — a USER declaration wins over the built-in template
    // (absent on both = text-only, the M14 negative capability).
    ...(user?.inputModalities !== undefined
      ? { inputModalities: user.inputModalities }
      : template?.inputModalities !== undefined ? { inputModalities: template.inputModalities } : {}),
    // M72 Ⅱ: the cap's field NAME — same user-wins-over-template rule. The
    // user setting is the only source in practice (no built-in template
    // declares it), but the chain is written out for the same reason the M59/M61
    // arms are: "absent" and "declared" must stay distinguishable here.
    ...(user?.maxTokensField !== undefined
      ? { maxTokensField: user.maxTokensField }
      : template?.maxTokensField !== undefined ? { maxTokensField: template.maxTokensField } : {}),
    // M72 Ⅲ: the usage ask — same user-wins-over-template rule, and the same
    // reason the arm is written out: `false` and "absent" must stay
    // distinguishable, since absent hands the decision to the adapter (ON).
    ...(user?.usageInStream !== undefined
      ? { usageInStream: user.usageInStream }
      : template?.usageInStream !== undefined ? { usageInStream: template.usageInStream } : {}),
    ...(user?.promptCache !== undefined
      ? { promptCache: { ...user.promptCache } }
      : template?.promptCache !== undefined ? { promptCache: { ...template.promptCache } } : {}),
    models,
    ...(template?.defaultModel !== undefined ? { defaultModel: template.defaultModel } : {}),
  }
}

/** The card family a route resolves against: its DECLARED `catalog`, else its
 * own name. The single implementation of that rule — `runtimeProfile()` writes
 * it onto the profile the chain reads, and `directory()` reports it, so what a
 * listing SHOWS and what resolution USES are the same value. */
export function cardFamilyOf(view: ProviderView): string {
  return view.catalog ?? view.id
}

export function runtimeProfile(
  view: ProviderView,
  apiKey: string | undefined,
  modelModalities?: SettingsInputModality[],
  selectionProtocol?: SettingsProviderProtocol,
  modelRetryLimit = 5,
): ProviderProfile | undefined {
  // SELECTION-or-row, computed by the caller: a session's/role's selection
  // beats the model row, and both beat the route's default. NOBODY INVENTS
  // ONE — an absent protocol is the caller's refusal to write (protocol-
  // selection §2), because this is the one place that can tell "absent"
  // from "declared".
  const protocol = selectionProtocol ?? view.protocol
  if (protocol === undefined) return undefined
  const template = { ...(view.template ?? {}) }
  delete template.apiKey
  delete template.inputModalities
  // Capability belongs to the selected model. The caller has already folded
  // a legacy route declaration onto a listed model, when present.
  const modalities = modelModalities
  return {
    ...template,
    retryPolicy: template.retryPolicy ?? { mode: "normal", maxRetries: modelRetryLimit },
    name: view.id,
    // Declared family, else the route name. Set here so the resolution chain
    // never has to look at `name` for a purpose it was not given.
    catalog: cardFamilyOf(view),
    displayName: view.displayName,
    // The route is an endpoint, and an endpoint has one protocol — a
    // declaration that names another is naming a different endpoint path
    // under the same host and credential.
    protocol: adapterProtocol(protocol),
    ...(view.baseURL !== undefined ? { baseUrl: view.baseURL } : {}),
    ...(view.apiKeyEnv !== undefined ? { apiKeyEnv: view.apiKeyEnv } : {}),
    ...(view.headers !== undefined ? { headers: view.headers } : {}),
    ...(modalities !== undefined ? { inputModalities: modalities } : {}),
    // M72 Ⅱ: route-level only (there is no per-model override of the wire's
    // field name — one endpoint spells a field one way).
    ...(view.maxTokensField !== undefined ? { maxTokensField: view.maxTokensField } : {}),
    // M72 Ⅲ: route-level only, for the same reason — one endpoint asks for
    // usage one way.
    ...(view.usageInStream !== undefined ? { usageInStream: view.usageInStream } : {}),
    ...(view.promptCache !== undefined ? { promptCache: { ...view.promptCache } } : {}),
    models: view.models.map((model) => model.id),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

function templateSettingsProtocol(
  template: ProviderProfile | undefined,
): SettingsProviderProtocol | undefined {
  if (template === undefined) return undefined
  return template.protocol === "openai-compatible" ? "openai-completions" : template.protocol
}

function adapterProtocol(protocol: SettingsProviderProtocol): ProviderProfile["protocol"] {
  return protocol === "openai-completions" ? "openai-compatible" : protocol
}
