import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerEditorRoutes } from "../editor/server.js";
import { handleHostRequest } from "../editor/host-core.js";
import { editorHostMethod } from "../editor/contract.js";

test("editor routes, Git changes and search stay inside each thread's current worktree", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "bb-1c-editor-"));
  const left = join(temp, "left");
  const right = join(temp, "right");
  const dataDir = join(temp, "editor-data");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  await mkdir(left);
  t.after(() => rm(temp, { recursive: true, force: true }));
  git(left, "init", "-q");
  git(left, "config", "core.autocrlf", "false");
  git(left, "config", "user.name", "Editor Test");
  git(left, "config", "user.email", "editor@example.invalid");
  await writeFile(join(left, "Module.bsl"), "// baseline\n");
  git(left, "add", "Module.bsl");
  git(left, "commit", "-qm", "Initial");
  git(left, "worktree", "add", "--detach", right);
  await writeFile(join(left, "left-marker.bsl"), "");
  await writeFile(join(right, "right-marker.bsl"), "");
  const paths = new Map([["left", left], ["right", right]]);
  let legacyEnabled = false;
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "1c-properties",
    sdk: {
      plugins: { list: async () => ({ plugins: legacyEnabled ? [{ id: "bsl-editor", enabled: true }] : [] }) },
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: threadId }) },
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({
        path: paths.get(environmentId), hostId: "host-" + environmentId,
      }) },
    },
  });
  t.after(() => harness.lifecycle.dispose());
  registerEditorRoutes(bb, async () => ({ interceptChatOpen: false, gitPath: "", gitReadTimeoutSec: 73 }),
    async (input, hostId) => {
      calls.push(hostId);
      return editorHostMethod.output.parse(await handleHostRequest({ ...input, dataDir }));
    });
  async function request(thread: string, method: "GET" | "POST", path: string, payload?: unknown, environmentId = thread) {
    const result = await harness.behavior.fetchHttp(method, "/bsl" + path, {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: { "content-type": "application/json", "x-bb-thread-id": thread, "x-bb-environment-id": environmentId },
    });
    return { status: result.status, body: await result.json() };
  }

  const blocked = await request("left", "POST", "/write", { path: "Module.bsl", content: "// wrong copy\n" }, "right");
  assert.equal(blocked.status, 409);
  legacyEnabled = true;
  assert.equal((await request("left", "GET", "/workspaces")).status, 409);
  assert.deepEqual(calls, []);
  legacyEnabled = false;
  const [leftSearch, rightSearch] = await Promise.all([
    request("left", "GET", "/search?q=marker"), request("right", "GET", "/search?q=marker"),
  ]);
  assert.deepEqual(leftSearch.body.results.map((item: { name: string }) => item.name), ["left-marker.bsl"]);
  assert.deepEqual(rightSearch.body.results.map((item: { name: string }) => item.name), ["right-marker.bsl"]);
  await writeFile(join(left, "ConfigDumpInfo.xml"), "<ConfigDumpInfo/>");
  await writeFile(join(left, "Configuration.xml"), "<MetaDataObject/>");
  await mkdir(join(right, "Configuration"));
  await writeFile(join(right, "Configuration", "Configuration.mdo"), "<Configuration/>");
  const metadata = await Promise.all(["left", "right"].map((name) => request(name, "GET", "/meta/status")));
  assert.equal(metadata[0].body.format, "xml");
  assert.equal(metadata[1].body.format, "edt");
  const moduleReads = await Promise.all(["left", "right"].map((name) => request(name, "GET", "/read?path=Module.bsl")));
  for (const read of moduleReads) assert.equal(read.body.content, "// baseline\n");
  assert.equal((await request("left", "GET", "/read?path=Configuration.xml")).body.content, "<MetaDataObject/>");
  const settings = await request("right", "GET", "/config");
  assert.equal(settings.body.gitReadTimeoutSec, 73);
  assert.equal(settings.body.interceptChatOpen, false);
  const writes = await Promise.all(["left", "right"].map((name) =>
    request(name, "POST", "/write", { path: "Module.bsl", content: "// " + name + "\n" })));
  for (const write of writes) assert.equal(write.status, 200, JSON.stringify(write.body));
  const diffs = await Promise.all(["left", "right"].map((name) => request(name, "GET", "/git-diff?path=Module.bsl")));
  assert.match(JSON.stringify(diffs[0].body), /\+\/\/ left/);
  assert.match(JSON.stringify(diffs[1].body), /\+\/\/ right/);
  await mkdir(dataDir);
  const formerRoot = left.replaceAll("\\", "/");
  const formerHead = git(left, "rev-parse", "HEAD").trim();
  await writeFile(join(dataDir, "reviewed.json"), JSON.stringify({
    [formerRoot]: { "Module.bsl": { headSha: formerHead, marks: [{ id: "migrated" }], hashes: ["migrated"] } },
  }));
  assert.deepEqual((await request("left", "GET", "/reviewed?path=Module.bsl")).body.hashes, ["migrated"]);
  const marks = await Promise.all(["left", "right"].map((name) =>
    request(name, "POST", "/reviewed", { path: "Module.bsl", hashes: [name] })));
  for (const mark of marks) assert.equal(mark.status, 200, JSON.stringify(mark.body));
  const reviewed = await Promise.all(["left", "right"].map((name) => request(name, "GET", "/reviewed?path=Module.bsl")));
  assert.deepEqual(reviewed[0].body.hashes, ["left"]);
  assert.deepEqual(reviewed[1].body.hashes, ["right"]);
  const reverts = await Promise.all(["left", "right"].map((name) =>
    request(name, "POST", "/revert-hunk", { path: "Module.bsl", index: 0 })));
  for (const revert of reverts) assert.equal(revert.status, 200, JSON.stringify(revert.body));
  assert.equal(await readFile(join(left, "Module.bsl"), "utf8"), "// baseline\n");
  assert.equal(await readFile(join(right, "Module.bsl"), "utf8"), "// baseline\n");
  assert.equal((await request("left", "POST", "/write", { path: "../right/Module.bsl", content: "wrong" })).status, 400);
});
