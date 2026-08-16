import { strict as assert } from "node:assert";
import { test } from "node:test";

import { hello } from "../src/index.ts";

test("hello() greets the given name", () => {
  assert.equal(hello("world"), "hello, world");
});