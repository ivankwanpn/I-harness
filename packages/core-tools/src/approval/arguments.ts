export function freezeArguments(value: unknown): void {
  const pending = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) pending.push(child)
    Object.freeze(current)
  }
}

export function approvalArgumentsSummary(args: unknown): string {
  try {
    const serialized = JSON.stringify(args, (key, value) => /token|secret|password|authorization|api.?key/i.test(key) ? "[redacted]" : value) ?? "null"
    return serialized.length > 4000 ? `${serialized.slice(0, 4000)}… [truncated]` : serialized
  } catch {
    return "[arguments unavailable]"
  }
}
