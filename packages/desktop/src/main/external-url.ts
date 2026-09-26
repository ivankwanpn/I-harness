/** Renderer links may open web pages, never local files or custom protocols. */
export function externalWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    if (url.username !== "" || url.password !== "") return undefined
    return url.href
  } catch { return undefined }
}
