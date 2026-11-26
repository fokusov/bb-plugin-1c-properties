import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

test("legacy embedded settings still release ownership to bb-unica v0.1.0", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "1c-properties",
    settings: { unicaMode: "embedded" },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.callRpc("unicaOwnership", {}), { version: 1, mode: "external" });
  const { agentTools, rpcMethods } = harness.inspection.registrations;
  assert.ok(agentTools.some(({ name }) => name === "project_1c_params"));
  assert.ok(agentTools.every(({ name }) => !name.startsWith("unica_")));
  assert.deepEqual(rpcMethods.filter((name) => /unica/i.test(name)), ["unicaOwnership"]);
  assert.equal((await harness.behavior.runCli(["unica", "status"])).exitCode, 1);
});

test("the first dispatch reads current workflow settings from the project source host", async (t) => {
  const snapshot = {
    path: "/source/bsl-flow.yaml", text: "workflow:\n  enabled: false\n",
    revision: "a".repeat(64), error: "", profile: { models: [], providers: [], roles: {}, error: "" },
  };
  let enabled: boolean | null = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "1c-properties",
    agentSkillIds: ["1c-project-properties"],
    experimental_callHostRpc: ({ method, hostId, input }) => {
      assert.equal(hostId, "fixture-host");
      if (method === "workflowEnabled") {
        assert.deepEqual(input, { path: "/source" });
        return enabled;
      }
      assert.equal(method, "saveBslFlowConfig");
      enabled = true;
      return { ...snapshot, enabled };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  harness.sdk.stub("projects.get", async ({ projectId }) => ({
    id: projectId, name: "Fixture", sources: [{ isDefault: true, path: "/source", hostId: "fixture-host" }],
  }));
  harness.sdk.stub("hosts.get", async () => ({ name: "Fixture host" }));
  await plugin(bb);
  const context = makePluginAgentConfigurationContext({
    environment: { path: "/worktrees/second" },
  });
  const hook = harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook);
  const dispatch = () => hook(makeMessageDispatchHookContext({
    project: { id: context.project.id, kind: "standard" },
    environment: { path: "/worktrees/second" },
    attempt: "start-turn",
  }));
  const save = () => harness.callRpc("saveBslFlowConfig", {
    projectId: context.project.id, revision: snapshot.revision, text: "workflow:\n  enabled: true\n",
  });
  assert.deepEqual(await dispatch(), { action: "proceed" });
  const current = await harness.behavior.resolveAgentConfiguration(context);
  assert.match(current.instructions ?? "", /workflow\.enabled: false/);
  assert.match(current.instructions ?? "", /--schema spec-driven/);
  const another = makePluginAgentConfigurationContext({ project: { ...context.project, id: "another-project" } });
  assert.equal((await harness.behavior.resolveAgentConfiguration(another)).instructions, null);
  await save();
  assert.equal((await harness.behavior.resolveAgentConfiguration(context)).instructions, null);

  enabled = false;
  await dispatch();
  assert.match((await harness.behavior.resolveAgentConfiguration(context)).instructions ?? "", /workflow\.enabled: false/);
  enabled = null;
  await dispatch();
  assert.equal((await harness.behavior.resolveAgentConfiguration(context)).instructions, null);
});
