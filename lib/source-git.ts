import { spawnSync } from "node:child_process";

export interface SourceGitState {
  available: boolean;
  repository: boolean | null;
  detail: string;
}

/** Read-only Git probe for the project checkout on the project host. */
export function inspectSourceGit(path: string): SourceGitState {
  try {
    const result = spawnSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { available: false, repository: null, detail: "Git не найден в PATH" };
    }
    if (result.error) {
      return { available: true, repository: null, detail: result.error.message };
    }
    if (result.status === 0 && result.stdout.trim() === "true") {
      return { available: true, repository: true, detail: "" };
    }
    return {
      available: true,
      repository: false,
      detail: result.stderr.trim() || "папка не является Git-репозиторием",
    };
  } catch (error) {
    return {
      available: false,
      repository: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
