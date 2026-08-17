/**
 * Minimal type surface for `@vscode/ripgrep`: an ESM module that resolves the
 * platform ripgrep binary (optional dependency `@vscode/ripgrep-<platform>-<arch>`)
 * and exports its absolute path as the named export `rgPath` (no bundled types).
 */
declare module "@vscode/ripgrep" {
  export const rgPath: string
}
