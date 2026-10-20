/** SDK process consent; consumed directory names are never options. */
export function sdkApprovesTools(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--session-dir') { index++; continue }
    if (args[index] === '--yes') return true
  }
  return false
}
