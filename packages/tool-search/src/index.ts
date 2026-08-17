// Minimal re-export stub so the package export ("./src/index.ts") resolves.
// Task 3 wires the search engine into ToolRegistry and may extend this file.
export { search, splitName, tokenize, searchText } from "./search.ts"
export type { Searchable, SearchOptions } from "./search.ts"
