import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { reviewTarget } from "../review-contract.js";

type ReviewTarget = z.infer<typeof reviewTarget>;

export function findReviewEvidence(path: string, change: string) {
  if (!statSync(join(path, "bsl-flow.yaml"), { throwIfNoEntry: false })?.isFile() ||
      !statSync(join(path, "openspec", "changes", change), { throwIfNoEntry: false })?.isDirectory()) return "unavailable";
  return statSync(join(path, "openspec", "changes", change, "review.json"), { throwIfNoEntry: false })?.isFile()
    ? "review-present" : "missing-review";
}

function git(path: string, ...args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 5_000,
  });

}

export function readReviewHead(path: string): string {
  try {
    return git(path, "rev-parse", "HEAD").trim();
  } catch {
    throw new Error("Рабочая копия Git или её HEAD недоступны на машине треда.");
  }
}

export function verifyReviewSource(path: string, target: ReviewTarget): string[] {
  const head = readReviewHead(path);
  if (head !== target.head) throw new Error(`HEAD рабочей копии изменился. Текущий HEAD: ${head}.`);

  if (target.kind === "git") {
    try {
      git(path, "cat-file", "-e", `${target.base}^{commit}`);
    } catch {
      throw new Error("Начальная ревизия диапазона недоступна в рабочей копии.");
    }
    return [];
  }

  const root = `openspec/changes/${target.change}`;
  const entries = git(path, "ls-tree", "-r", "-z", target.head, "--", root).split("\0");
  const files = entries.flatMap((entry) => {
    const [type, file] = entry.split("\t");
    if (!/^100(?:644|755) blob /u.test(type) || !file?.startsWith(`${root}/`)) return [];
    const name = file.slice(root.length + 1);
    return /^(?:proposal|design|tasks|spec)\.md$/u.test(name) || /^specs\/(?:[a-z0-9_-]+\/)*spec\.md$/u.test(name) ? [file] : [];
  });
  if (!files.length) throw new Error("Артефакты OpenSpec отсутствуют в указанном HEAD.");
  if (files.length > 50) throw new Error("В изменении более 50 артефактов OpenSpec.");
  return files;
}
