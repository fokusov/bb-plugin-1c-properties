import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readPassport } from "../lib/passport.js";
import { rpcContract } from "../rpc.js";

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

async function gitRoot() {
  const root = await mkdtemp(join(tmpdir(), "1c-passport-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

test("passport is read-only, bounded, and tied to each of two independent roots", async () => {
  const xmlRoot = await gitRoot();
  await mkdir(join(xmlRoot, "Catalogs"));
  await writeFile(join(xmlRoot, "Configuration.xml"), '<MetaDataObject><Configuration><Name>Alpha</Name><Synonym><item><content>Alpha Config</content></item></Synonym><Version>1.2</Version></Configuration></MetaDataObject>');
  await writeFile(join(xmlRoot, "Module.bsl"), "Процедура Тест()\nКонецПроцедуры\n");
  await writeFile(join(xmlRoot, "Infobase.1cd"), "database binary");
  execFileSync("git", ["-C", xmlRoot, "add", "Configuration.xml", "Module.bsl", "Infobase.1cd"]);
  await writeFile(join(xmlRoot, "untracked.bsl"), "untracked\n");
  const before = execFileSync("git", ["-C", xmlRoot, "status", "--porcelain"]).toString();
  const xml = await readPassport(xmlRoot);
  assert.equal(xml.configurations[0]?.format, "object");
  assert.equal(xml.configurations[0]?.name, "Alpha");
  assert.equal(xml.configurations[0]?.version, "1.2");
  assert.equal(xml.metrics.complete, true);
  assert.equal(xml.metrics.trackedFiles, 2);
  assert.equal(execFileSync("git", ["-C", xmlRoot, "status", "--porcelain"]).toString(), before);

  const edtRoot = await gitRoot();
  await mkdir(join(edtRoot, "Configuration"));
  await writeFile(join(edtRoot, "Configuration", "Configuration.mdo"), '<mdclass:Configuration><Name>Beta</Name><Version>4.0</Version></mdclass:Configuration>');
  const edt = await readPassport(edtRoot);
  assert.equal(edt.configurations[0]?.format, "edt");
  assert.equal(edt.configurations[0]?.name, "Beta");
  assert.equal(edt.metrics.complete, true);
  assert.equal(edt.metrics.trackedFiles, 0);
  assert.equal(rpcContract.passport.input.safeParse({ projectId: "p", environmentId: "e" }).success, true);
  assert.equal(rpcContract.passport.input.safeParse({ projectId: "p", path: "C:/" }).success, false);
});

test("passport v2 counts tracked code and top-level XML/EDT metadata by root", async () => {
  const root = await gitRoot();
  await mkdir(join(root, "Catalogs", "Product", "Forms"), { recursive: true });
  await mkdir(join(root, "extension", "Configuration"), { recursive: true });
  await mkdir(join(root, "extension", "CommonModules", "Extra"), { recursive: true });
  await writeFile(join(root, "Configuration.xml"), "<Configuration><Name>Core</Name></Configuration>");
  await writeFile(join(root, "Catalogs", "Product.xml"), "<Catalog/>");
  await writeFile(join(root, "Catalogs", "Product", "Forms", "Card.xml"), "<Form/>");
  await writeFile(join(root, "extension", "Configuration", "Configuration.mdo"), "<mdclass:Configuration><name>Extension</name><configurationExtensionPurpose>AddOn</configurationExtensionPurpose></mdclass:Configuration>");
  await writeFile(join(root, "extension", "CommonModules", "Extra", "Extra.mdo"), "<CommonModule/>");
  await writeFile(join(root, "Module.bsl"), "Первая\r\n\r\nТретья");
  await writeFile(join(root, "extension", "CommonModules", "Extra", "Module.bsl"), Buffer.from("\uFEFFСтрока\r\n", "utf16le"));
  execFileSync("git", ["-C", root, "add", "."]);
  await writeFile(join(root, "ignored.bsl"), "Неотслеживаемый модуль");
  const snapshot = await readPassport(root, true);
  assert.deepEqual(snapshot.structure, {
    bslModules: 2, bslLines: 4, objectsByRoot: { ".": 1, extension: 1 },
    extensions: [{ root: "extension", purpose: "AddOn" }],
  });
  assert.equal((await readPassport(root)).structure, undefined);
});
