export const GUARDIAN_JSON_CONTRACT =
  'Output STRICT JSON only — one object, no fences, no prose: ' +
  '{"outcome":"approve"|"allow"|"deny","rationale":"<1-2 sentence reason>","risk_level":"none"|"moderate"|"high"} ' +
  "outcome=deny never executes; outcome=approve proceeds without asking the user; outcome=allow asks the user."

export interface ParsedGuardianAssessment {
  outcome: "approve" | "allow" | "deny"
  rationale: string
  riskLevel: "none" | "moderate" | "high"
}

const OUTCOMES = new Set(["approve", "allow", "deny"])
const RISK_LEVELS = new Set(["none", "moderate", "high"])

// Strict JSON contract (codex parse_guardian_assessment re-implementation):
// the WHOLE output must be one JSON object with the exact enum values and a
// non-empty rationale. Fences, trailing prose or any extra field ⇒ undefined
// (the caller fails closed by denying). Extra FIELDS are tolerated (additive
// forwards-compat) but the three required fields must be present.
export function parseGuardianAssessment(text: string): ParsedGuardianAssessment | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome)) return undefined
  if (typeof v.risk_level !== "string" || !RISK_LEVELS.has(v.risk_level)) return undefined
  if (typeof v.rationale !== "string" || v.rationale.trim().length === 0) return undefined
  return {
    outcome: v.outcome as ParsedGuardianAssessment["outcome"],
    rationale: v.rationale.trim(),
    riskLevel: v.risk_level as ParsedGuardianAssessment["riskLevel"],
  }
}
