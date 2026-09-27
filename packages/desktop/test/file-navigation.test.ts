import { expect, it } from "vitest"
import { toolFilePath } from "../src/renderer/session/file-navigation.ts"
it("converts explicit in-workspace file targets while rejecting external or traversing paths", () => {
  expect(toolFilePath("read", { path: "d:\\REPO\\src\\main.ts" }, "D:/repo")).toBe("src/main.ts")
  expect(toolFilePath("write", { path: "./notes/readme.md" }, "D:/repo")).toBe("notes/readme.md")
  for (const path of ["../secret", "D:/repo-other/file", "C:/secret", "https://example.com/file", "file:///D:/repo/a", "a:stream"]) expect(toolFilePath("read", { path }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("bash", { command: "cat a.txt", path: "a.txt" }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("list_dir", { path: "src" }, "D:/repo")).toBeUndefined()
  expect(toolFilePath("read", { path: "/home/User/a" }, "/home/user")).toBeUndefined()
})
