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
// M6 batch C C1 (spec 2026-09-21-m6-breadth-design §3.2): the skills catalogue
// as a runtime-context section — its production consumer is the assembly.
// The budget constant and the options type stay OFF this entry on purpose:
// their readers are the section itself and its tests, which import the module
// path directly, so re-exporting them would add a name the gate reports as
// declared-but-unused.
export { createSkillsSection } from "./section.ts"
// M6 batch C C2 (spec §3.2): the `$name` sigil scan. Unlike the section's
// constant above, BOTH of these names leave the entry: their production
// consumer is the assembly's pre-step listener, which imports them from here.
export { scanMentionedSkillNames, SKILL_MENTION_PLUGIN } from "./mention.ts"
// M27 R-B6: shadow selector + implicit-invocation vocabulary (pure, no I/O).
export {
  selectShadowCandidates,
  explicitMentionMatches,
  type ShadowCandidate,
  type ShadowReport,
  type SkillSelectorEvent,
  type SkillTelemetryEmitter,
} from "./shadow.ts"
