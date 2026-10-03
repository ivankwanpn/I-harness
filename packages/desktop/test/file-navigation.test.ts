import { expect, it } from "vitest"
import { toolFilePath, toolProjectFileRef } from "../src/renderer/session/file-navigation.ts"
it("converts explicit in-workspace file targets while rejecting external or traversing paths", () => {
  expect(toolFilePath("read", { path: "d:\\REPO\\src\\main.ts" }, "D:/repo")).toBe("src/main.ts")
  expect(toolFilePath("write", { path: "./notes/readme.md" }, "D:/repo")).toBe("notes/readme.md")
  for (const path of ["../secret", "D:/repo-other/file", "C:/secret", "https://example.com/file", "file:///D:/repo/a", "a:stream"]) expect(toolFilePath("read", { path }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("bash", { command: "cat a.txt", path: "a.txt" }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("list_dir", { path: "src" }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("read", { path: "/home/User/a" }, "/home/user")).toBeUndefined()
})

it("routes a tool file to its owning project root without aliasing equal relative paths", () => {
  const roots = [{ workspaceId: "first", path: "D:/first" }, { workspaceId: "second", path: "D:/second" }]
  expect(toolProjectFileRef("read", { path: "D:/second/same.txt" }, "first", roots)).toEqual({ workspaceId: "second", path: "same.txt" })
  expect(toolProjectFileRef("edit", { path: "same.txt" }, "second", roots)).toEqual({ workspaceId: "second", path: "same.txt" })
  expect(toolProjectFileRef("read", { path: "D:/second/same.txt" }, "first", [roots[0]!])).toBeUndefined()
  expect(toolProjectFileRef("read", { path: "../second/same.txt" }, "first", roots)).toBeUndefined()
})
