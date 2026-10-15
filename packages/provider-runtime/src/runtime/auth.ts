import { createProviderAuthResolver, type ProviderAuthRef, type ProviderAuthResolver, type ResolvedProviderAuth } from "@i-harness/credentials"
import type { ProviderView } from "../directory/types.ts"
import type { CreateProviderRuntimeOptions } from "../types.ts"

export function authRef(view: ProviderView): ProviderAuthRef | undefined {
  if (view.user?.oauthAccountId) return { kind: "oauth-account-ref", accountId: view.user.oauthAccountId }
  if (view.apiKeyEnv !== undefined) return { kind: "api-key-ref", ref: view.apiKeyEnv }
  if (view.protocol === "bedrock") return { kind: "ambient" }
  return undefined
}

export function authValue(auth: ResolvedProviderAuth | undefined): string | undefined {
  if (auth?.kind === "api-key") return auth.value.trim() === "" ? undefined : auth.value
  if (auth?.kind === "bearer") return auth.accessToken.trim() === "" ? undefined : auth.accessToken
  return undefined
}

export function createRuntimeAuth(options: Pick<CreateProviderRuntimeOptions, "auth" | "credentials" | "codex">): ProviderAuthResolver {
  const baseAuth = options.auth ?? createProviderAuthResolver(options.credentials)
  const auth: ProviderAuthResolver = {
    async describe(ref) {
      if (ref.kind !== "oauth-account-ref") return baseAuth.describe(ref)
      const account = await options.codex?.state()
      return { configured: account?.accountId === ref.accountId && account?.status === "connected", source: "oauth", writable: false }
    },
    async resolve(ref, context) {
      if (ref.kind !== "oauth-account-ref") return baseAuth.resolve(ref, context)
      if (!options.codex) return undefined
      const token = await options.codex.token(ref.accountId, context.signal)
      return { kind: "bearer", accessToken: token.accessToken, ...(token.authEpoch ? { authEpoch: token.authEpoch } : {}) }
    },
  }
  return auth
}
