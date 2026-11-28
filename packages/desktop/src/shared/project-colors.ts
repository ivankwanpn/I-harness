export const projectColors = ["default", "blue", "green", "amber", "violet", "rose"] as const
export type ProjectColor = typeof projectColors[number]

export function isProjectColor(value: unknown): value is ProjectColor {
  return projectColors.some(color => color === value)
}
