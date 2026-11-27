import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  configurationIdentitySchema, platformCfuDetailsSchema,
  type ConfigurationIdentity, type PlatformCfuDetails,
} from "../platform-contract.js";
import { comErrorText, designerSpawnArguments, pickPowerShell } from "./designer.js";
import { readBoundedText, redactLog } from "./platform-journal.js";
import { assertStandaloneFileBase, platformFileStamp, type PlatformPlan } from "./platform-plan.js";

const execute = promisify(execFile);
const cfuInspectionSchema = z.object({
  current: configurationIdentitySchema,
  target: configurationIdentitySchema.optional(),
  sources: z.array(configurationIdentitySchema).max(250).optional(),
}).strict();

const readConfiguration = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Get-Property($object, $name) {
    return ,($object.GetType().InvokeMember($name, [Reflection.BindingFlags]::GetProperty, $null, $object, @()))
}
function Call-Method($object, $name, [object[]]$arguments) {
    return ,($object.GetType().InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $object, $arguments))
}
function Get-Identity($object) {
    return [ordered]@{
        name = [string](Get-Property $object 'Имя')
        vendor = [string](Get-Property $object 'Поставщик')
        version = [string](Get-Property $object 'Версия')
    }
}
function Get-Version($file) {
    $info = (Get-Item -LiteralPath $file).VersionInfo
    return "$($info.FileMajorPart).$($info.FileMinorPart).$($info.FileBuildPart).$($info.FilePrivatePart)"
}
$connector = $null
$connection = $null
try {
    $platform = (Get-Item -LiteralPath $env:BB_CFU_PLATFORM).VersionInfo
    $class = if ($platform.FileMajorPart -eq 8 -and $platform.FileMinorPart -eq 5) { 'V85.COMConnector' } else { 'V83.COMConnector' }
    $connectorType = [Type]::GetTypeFromProgID($class)
    if ($null -eq $connectorType) { throw "$class не зарегистрирован." }
    $classId = $connectorType.GUID.ToString('B')
    $library = (Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\CLSID\$classId\InprocServer32").GetValue('')
    if ((Get-Version $library) -ne (Get-Version $env:BB_CFU_PLATFORM)) { throw 'Версия COMConnector не совпадает с выбранной платформой.' }
    $connector = New-Object -ComObject $class
    $connection = $connector.Connect($env:BB_CFU_CONNECTION)
    $configuration = Call-Method $connection 'NewObject' @('BinaryData', $env:BB_CFU_DATABASE_CONFIG)
    $current = Call-Method $connection 'NewObject' @('ConfigurationDescription', $configuration)
    $result = [ordered]@{ current = (Get-Identity $current) }
    if ($env:BB_CFU_FILE) {
        $binary = Call-Method $connection 'NewObject' @('BinaryData', $env:BB_CFU_FILE)
        $description = Call-Method $connection 'NewObject' @('ConfigurationUpdateDescription', $binary)
        $result.target = Get-Identity (Get-Property $description 'TargetConfiguration')
        $sources = Get-Property $description 'SourceConfigurations'
        $count = Call-Method $sources 'Count' @()
        if ($count -gt 250) { throw 'Список исходных версий CFU слишком велик.' }
        $result.sources = @(for ($i = 0; $i -lt $count; $i++) { Get-Identity (Call-Method $sources 'Get' @($i)) })
    }
    $result | ConvertTo-Json -Depth 6 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $connection) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($connection) }
    if ($null -ne $connector) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($connector) }
}
`;

export async function hashPlatformFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export function sameConfiguration(left: ConfigurationIdentity, right: ConfigurationIdentity): boolean {
  return left.name === right.name && left.vendor === right.vendor && left.version === right.version;
}

export async function snapshotCfuBase(base: string, destination: string): Promise<string> {
  const source = join(base, "1Cv8.1CD");
  assertStandaloneFileBase(source);
  const stamp = platformFileStamp(source);
  await mkdir(destination);
  await copyFile(source, join(destination, "1Cv8.1CD"), constants.COPYFILE_EXCL);
  assertStandaloneFileBase(source);
  if (platformFileStamp(source) !== stamp) throw new Error("FILE-база изменилась при создании снимка.");
  return stamp;
}

export function cfuDetails(
  sha256: string, current: ConfigurationIdentity, target: ConfigurationIdentity, sources: ConfigurationIdentity[],
): PlatformCfuDetails {
  if (!current.vendor || !current.version || current.name !== target.name || current.vendor !== target.vendor) {
    throw new Error("Поставщик или имя конфигурации в CFU не совпадает с конфигурацией базы.");
  }
  const allowedVersions = [...new Set(sources
    .filter(({ name, vendor }) => current.name === name && current.vendor === vendor)
    .map(({ version }) => version).filter(Boolean))];
  if (!allowedVersions.includes(current.version)) {
    throw new Error(`Версия базы ${current.version} отсутствует среди исходных версий этого CFU.`);
  }
  if (!target.version || target.version === current.version) {
    throw new Error("CFU не задаёт новую версию конфигурации.");
  }
  return platformCfuDetailsSchema.parse({ sha256, current, target, allowedVersions });
}

type Auth = { user: string; password: string; unlockCode: string };

async function runInspection(exe: string, directory: string, args: string[], file: string, auth: Auth, signal?: AbortSignal) {
  const result = join(directory, file + ".result");
  const log = join(directory, file + ".log");
  const full = [...args, "/DisableStartupDialogs", "/DisableStartupMessages", "/Out", log, "/DumpResult", result];
  const prepared = designerSpawnArguments(exe, full);
  let exitCode: number | string | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const process = spawn(exe, prepared.args, {
        windowsHide: true, signal, timeout: 60_000, stdio: "ignore", ...prepared.options,
      });
      process.once("error", reject);
      process.once("close", resolve);
    });
  } catch (error) {
    signal?.throwIfAborted();
    exitCode = (error as { code?: string | number }).code ?? "нет";
  }
  if (exitCode !== 0 || !existsSync(result) || readBoundedText(result, 512).trim() !== "0") {
    const details = existsSync(log) ? readBoundedText(log, 4096, true).trim() : `код процесса ${exitCode}`;
    throw new Error(`Не удалось выполнить ${file}: ${redactLog(details, [auth.password, auth.unlockCode])}`);
  }
}

export async function readCfuConfiguration(
  exe: string, base: string, auth: Auth, file?: string, signal?: AbortSignal,
) {
  if (process.platform !== "win32") throw new Error("Проверка CFU требует Windows и COMConnector выбранной платформы.");
  const temp = await mkdtemp(join(tmpdir(), "bb-cfu-"));
  try {
    const databaseConfig = join(temp, "database.cf");
    const empty = join(temp, "reader");
    const snapshot = join(temp, "snapshot");
    await snapshotCfuBase(base, snapshot);
    signal?.throwIfAborted();
    const credentials = [
      ...(auth.user ? ["/N", auth.user] : []), ...(auth.password ? ["/P", auth.password] : []),
      ...(auth.unlockCode ? ["/UC", auth.unlockCode] : []),
    ];
    await runInspection(exe, temp, ["DESIGNER", `/F${snapshot}`, ...credentials, "/DumpDBCfg", databaseConfig], "DumpDBCfg", auth, signal);
    // Read the binary descriptors in a blank infobase to keep customer configuration code out of the inspection.
    await runInspection(exe, temp, ["CREATEINFOBASE", `File="${empty}";`], "CREATEINFOBASE", auth, signal);
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(readConfiguration, "utf16le").toString("base64")];
    try {
      const { stdout } = await execute(pickPowerShell(exe).exe, args, {
        windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024, signal, encoding: "utf8",
        env: {
          ...process.env, BB_CFU_PLATFORM: exe, BB_CFU_CONNECTION: `File="${empty}";`,
          BB_CFU_DATABASE_CONFIG: databaseConfig, BB_CFU_FILE: file ?? "",
        },
      });
      return cfuInspectionSchema.parse(JSON.parse(stdout));
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as { stderr?: string; killed?: boolean };
      const detail = failure.stderr?.trim().slice(0, 1000) || (failure.killed ? "истекло время ожидания COM" : "некорректный ответ COM");
      throw new Error(`Не удалось прочитать сведения о конфигурации: ${comErrorText(redactLog(detail, [auth.password, auth.unlockCode]))}`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function inspectCfuPlan(
  plan: PlatformPlan, auth: { user: string; password: string; unlockCode: string }, signal?: AbortSignal,
) {
  if (plan.baseArg === null || !plan.cfu || !plan.baseFile || !plan.preview.input || !plan.preview.confirmation) {
    throw new Error("Ожидался план применения CFU к FILE-базе.");
  }
  const { baseFile, preview } = plan;
  assertStandaloneFileBase(baseFile);
  const file = preview.input!;
  const fileStamp = platformFileStamp(file);
  const hash = await hashPlatformFile(file, signal);
  if (hash !== plan.cfu.sha256) throw new Error("SHA-256 файла CFU не совпадает с доверенной контрольной суммой.");
  const { current, target, sources } = await readCfuConfiguration(preview.platform, preview.target, auth, file, signal);
  assertStandaloneFileBase(baseFile);
  if (!target || !sources) throw new Error("Платформа не вернула описание целевой и исходных конфигураций CFU.");
  if (platformFileStamp(file) !== fileStamp || platformFileStamp(baseFile) !== plan.cfu.baseStamp) {
    throw new Error("Файл CFU или база изменились при чтении. Выполни предпросмотр заново.");
  }
  const details = cfuDetails(hash, current, target, sources);
  preview.cfu = details;
  preview.confirmation = createHash("sha256").update(JSON.stringify([preview.confirmation, details])).digest("hex");
  return preview;
}
