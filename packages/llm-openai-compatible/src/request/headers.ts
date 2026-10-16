/** M60 G: configured headers merged UNDER the adapter's own request headers.
 * Configured names are lower-cased and any that collide (case-insensitively)
 * with an adapter-owned name are DROPPED — Fetch combines `Authorization` and
 * `authorization` into one comma-joined value, so a case-variant duplicate
 * would corrupt the auth header. */
export function mergeConfiguredHeaders(
  configured: Record<string, string> | undefined,
  owned: Record<string, string>,
): Record<string, string> {
  const taken = new Set(Object.keys(owned).map((key) => key.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(configured ?? {})) {
    const lower = key.toLowerCase()
    if (!taken.has(lower)) out[lower] = value
  }
  return { ...out, ...owned }
}
