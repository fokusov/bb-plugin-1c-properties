import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldExposeRlmTools } from "../lib/agent-tools.js";

test("RLM tools require project opt-in and do not depend on Unica status", () => {
  assert.equal(shouldExposeRlmTools(true, false), false);
  assert.equal(shouldExposeRlmTools(true, true), true);
  assert.equal(shouldExposeRlmTools(false, true), false);
});
