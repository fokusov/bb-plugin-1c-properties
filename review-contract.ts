import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const reviewChangeId = z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const reviewTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("git"), base: revision, head: revision }).strict(),
  z.object({ kind: z.literal("openspec"), change: reviewChangeId, head: revision }).strict(),
]);

export const reviewSource = z.object({ threadId: identifier, environmentId: identifier }).strict();
export const reviewRecord = z.object({
  role: z.literal("reviewer"),
  taskId: identifier,
  parentThreadId: identifier,
  sourceEnvironmentId: identifier,
  model: identifier,
  reviewMode: z.literal("isolated-worktree"),
  target: reviewTarget,
});

export const reviewContract = defineRpcContract({
  reviewContext: {
    input: reviewSource,
    output: z.object({ head: revision }),
  },
  reviewEvidence: {
    input: reviewSource.extend({ change: reviewChangeId }).strict(),
    output: z.enum(["missing-review", "review-present", "unavailable"]),
  },
  reviewStart: {
    input: reviewSource.extend({
      target: reviewTarget,
      taskId: identifier,
      providerId: identifier,
      model: identifier,
      reasoningLevel: identifier.optional(),
      serviceTier: identifier.optional(),
      brief: z.string().trim().min(1).max(4_000),
      isolatedWorktree: z.literal(true),
    }).strict(),
    output: z.object({ threadId: identifier }),
  },
  reviewList: {
    input: reviewSource,
    output: z.array(reviewRecord.extend({
      threadId: identifier,
      title: z.string().nullable(),
      status: z.string(),
      environmentId: z.string().nullable(),
    })),
  },
});
