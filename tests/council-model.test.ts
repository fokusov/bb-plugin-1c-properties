import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCatalogModel } from "../lib/council-model.js";

test("the picker preserves API model IDs and only unwraps the OpenCode catalog namespace", () => {
  assert.deepEqual(resolveCatalogModel("codex", "gpt-6.2-sol"), {
    providerHint: "openai", modelId: "gpt-6.2-sol",
  });
  assert.deepEqual(resolveCatalogModel("opencode2", "deepseek/deepseek-flash"), {
    providerHint: "deepseek", modelId: "deepseek-flash",
  });
  assert.deepEqual(resolveCatalogModel("opencode2", "openrouter/anthropic/example"), {
    providerHint: "openrouter", modelId: "anthropic/example",
  });
  assert.deepEqual(resolveCatalogModel("another-provider", "anthropic/example"), {
    providerHint: "another-provider", modelId: "anthropic/example",
  });
});
