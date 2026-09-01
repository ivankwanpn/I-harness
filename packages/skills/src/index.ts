// @i-harness/skills — SKILL.md deferred retrieval: skill registry (workspace +
// global scan), front-matter parsing (yaml package), BM25 search reusing
// @i-harness/tool-search, and the skill_search/skill_get tool surface.
export {
  parseFrontmatter,
  type ParsedSkill,
  type SkillFrontmatter,
} from "./frontmatter.ts"
export {
  createSkillRegistry,
  isValidSkillName,
  SkillToolError,
  SKILL_FILE,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  MAX_SKILL_DEPTH,
  MAX_SKILL_ENTRIES,
  type Skill,
  type SkillRegistry,
  type SkillRegistryDeps,
  type SkillSource,
  type SkillSummary,
  type SkillToolErrorCode,
} from "./registry.ts"
export { toSearchable, searchSkillSummaries, type SearchOptions, type Searchable } from "./search.ts"
export {
  skillSearchName,
  skillGetName,
  skillsServiceName,
  skillsPluginName,
  createSkillSearchTool,
  createSkillGetTool,
  registerSkills,
  createSkillsPlugin,
  type SkillToolDeps,
  type SkillsMountConfig,
  type SkillsMountHandle,
  type SkillSearchArgs,
  type SkillSearchMatch,
  type SkillSearchOutput,
  type SkillGetArgs,
  type SkillGetOutput,
} from "./tool.ts"
// M27 R-B6: shadow selector + implicit-invocation vocabulary (pure, no I/O).
export {
  selectShadowCandidates,
  explicitMentionMatches,
  type ShadowCandidate,
  type ShadowReport,
  type SkillSelectorEvent,
  type SkillTelemetryEmitter,
} from "./shadow.ts"
