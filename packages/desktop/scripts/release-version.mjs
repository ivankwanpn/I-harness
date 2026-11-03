// Application identity stays full SemVer; Windows PE fields are four uint16s.
export function validateReleaseVersion(version) {
  const match = typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match || match[0] !== version || match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error("application version must be valid, safe SemVer")
  }
  const numeric = match.slice(1, 4).map(Number)
  if (numeric.some(part => !Number.isInteger(part) || part > 65535)) throw new Error("application version cannot be represented in Windows numeric version fields (0..65535)")
  return { version, windowsVersion: [...numeric, 0].join(".") }
}
