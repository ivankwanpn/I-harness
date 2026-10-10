import { dirname, join, resolve } from "node:path"

/** Only the registry's installed <home>/plugins/<id>/hooks/hooks.json tree
 * opts into Claude adaptation. Authored/native configurations keep their parser. */
export function installedPluginHookRoot(configDir: string, configPath: string): string | undefined {
  const path = resolve(configPath), root = dirname(dirname(path))
  const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  return canonical(dirname(root)) === canonical(resolve(configDir, "plugins"))
    && canonical(path) === canonical(join(root, "hooks", "hooks.json")) ? root : undefined
}
