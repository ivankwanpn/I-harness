/** Resource collection shared by Developer API discovery and generation. */
export function geminiModelsURL(base = "https://generativelanguage.googleapis.com"): string {
  const root = base.replace(/\/+$/, "")
  return new URL(root).pathname.endsWith("/v1beta") ? root + "/models" : root + "/v1beta/models"
}

export function geminiModelId(resource: string): string {
  return resource.replace(/^models\//, "")
}
