// M49 Task 8: RosePineMoon palette — RGB literals ported from the Grok source
// inventory (xai-grok-pager-render `theme/rosepine.rs`: base #232136, surface
// #2a273f, overlay #393552, muted #6e6a86, subtle #908caa, text #e0def4, love
// #eb6f92, gold #f6c177, rose #ea9a97, pine #3e8fb0, foam #9ccfd8, iris
// #c4a7e7, highlights #2a283e/#44415a/#56526e, diff 371e28/192d37). Semantic
// port — NOT from screenshots. All slots use the GrokNite field names and flow
// through the capability quantizers (256/16/mono).

import type { Palette } from "./index.ts"

export const ROSEPINE_MOON: Palette = Object.freeze<Palette>({
  name: "rose-pine-moon",
  bgTerminal: "#232136",
  bgDark: "#2a273f",
  bgBase: "#232136",
  bgLight: "#393552",
  bgHover: "#44415a",
  bgVisual: "#44415a",
  textPrimary: "#e0def4",
  textSecondary: "#908caa",
  gray: "#6e6a86",
  grayBright: "#908caa",
  grayDim: "#44415a",
  accentUser: "#e0def4",
  accentAssistant: "#c4a7e7",
  accentSystem: "#3e8fb0",
  accentError: "#eb6f92",
  accentSuccess: "#9ccfd8",
  accentPlan: "#f6c177",
  accentVerify: "#3e8fb0",
  accentFeedback: "#9ccfd8",
  accentModel: "#3e8fb0",
  command: "#f6c177",
  path: "#ea9a97",
  running: "#9ccfd8",
  warning: "#f6c177",
  promptBorder: "#44415a",
  promptBorderActive: "#56526e",
  hoverBorder: "#44415a",
  selectionBorder: "#56526e",
  scrollbarBg: "#2a283e",
  scrollbarFg: "#393552",
  diffDeleteBg: "#371e28",
  diffDeleteFg: "#eb6f92",
  diffInsertBg: "#192d37",
  diffInsertFg: "#9ccfd8",
  diffEqualFg: "#6e6a86",
  mdHeading: ["#e0def4", "#9ccfd8", "#c4a7e7", "#ea9a97", "#f6c177", "#3e8fb0"],
  mdCode: "#9ccfd8",
  mdTaskChecked: "#9ccfd8",
  mdTaskUnchecked: "#908caa",
  mdMuted: "#6e6a86",
  mdCodeBg: "#2a273f",
  mdText: "#e0def4",
  linkFg: "#9ccfd8",
  pasteBg: "#2a273f",
  pasteFg: "#908caa",
})
