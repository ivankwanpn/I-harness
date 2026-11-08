// Public package facade. Internal modules retain their own responsibilities.

export type { ProviderProtocol, ProviderModelContext, ProviderProfile, ModelDescriptor, ProbeRequest, Probe, ProviderRegistry, WireClientConfig } from "./types.ts"
export type { ModelCard, ModelCatalogRow, ModelCatalogFamilySource, ModelCatalogProvenance } from "./catalog/load.ts"
export { resolveEffectiveModelContextEvidence } from "./catalog/context.ts"
export { resolveModelCard, resolveModelCatalogProvenance, listModelCatalogFamily } from "./catalog/resolve.ts"
export { probeCandidatePaths } from "./probe/http.ts"
export { createProviderRegistry, defaultProviderRegistry } from "./probe/registry.ts"
export { buildModelClient } from "./clients/build.ts"
export { registerWebSearchProvider, tryGetWebSearchProvider, getWebSearchProvider, type WebSearchRequest, type WebSearchSource, type WebSearchResult, type WebSearchProvider } from "./web-search/registry.ts"
export { DeepSeekSearchProvider, DEEPSEEK_SEARCH_DEFAULT_BASE_URL, DEEPSEEK_SEARCH_DEFAULT_MODEL, DEEPSEEK_SEARCH_DEFAULT_API_VERSION, DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS, DEEPSEEK_SEARCH_DEFAULT_MAX_USES, type DeepSeekSearchOptions } from "./web-search/deepseek.ts"
export { TavilySearchProvider, TAVILY_SEARCH_ENDPOINT, type TavilySearchOptions } from "./web-search/tavily.ts"
