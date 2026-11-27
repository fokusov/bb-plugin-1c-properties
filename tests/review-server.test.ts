import assert from "node:assert/strict";
import test from "node:test";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { registerReview } from "../lib/review-server.js";
import { reviewContract, strictReviewUnavailable } from "../review-contract.js";

test("strict read-only reviews fail before a worktree or child thread can be created", async () => {
  let handlers: PluginRpcHandlers<typeof reviewContract> | undefined;
  const bb = {
    get sdk() { throw new Error("Strict review must stop before accessing BB execution"); },
    rpc: { register: (_contract: typeof reviewContract, registered: typeof handlers) => { handlers = registered; } },
  } as unknown as BbPluginApi;
  const unexpectedHostCall = async () => { throw new Error("Strict review must stop before reading project files"); };
  registerReview(bb, { head: unexpectedHostCall, evidence: unexpectedHostCall, files: unexpectedHostCall });
  assert.ok(handlers);
  const head = "a".repeat(40);
  const args = reviewContract.reviewStart.input.parse({
    threadId: "thr_test", environmentId: "env_test", target: { kind: "git", base: head, head },
    taskId: "strict-pilot", providerId: "codex", model: "pilot-model",
    isolatedWorktree: true, requireReadOnly: true, brief: "Strict acceptance case",
  });
  await assert.rejects(async () => { await handlers!.reviewStart(args); }, {
    message: strictReviewUnavailable,
  });
});
