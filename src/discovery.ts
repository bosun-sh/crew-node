import { readdirSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { GIT_HARDENING_ARGS } from "./git-policy.js";
import { commandEnv } from "./policy.js";

export type DiscoveredRepository = { path: string; name: string; gitRemote?: string; defaultBranch?: string };

export function discoverRepositories(workspaceRoot: string): DiscoveredRepository[] {
  const root = realpathSync(workspaceRoot);
  const repositories: DiscoveredRepository[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 4 || repositories.length >= 200) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
      const verified = realpathSync(directory);
      const path = relative(root, verified).split(sep).join("/") || ".";
      if (path === ".." || path.startsWith("../")) return;
      const gitRemote = git(verified, ["config", "--get", "remote.origin.url"]);
      const defaultBranch = git(verified, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") ?? git(verified, ["branch", "--show-current"]);
      repositories.push({ path, name: basename(verified), ...(gitRemote ? { gitRemote } : {}), ...(defaultBranch ? { defaultBranch } : {}) });
      return;
    }
    for (const entry of entries) if (entry.isDirectory() && ![".git", ".crew-audit", "node_modules"].includes(entry.name)) visit(resolve(directory, entry.name), depth + 1);
  };
  visit(root, 0);
  return repositories;
}

// Bypasses checkCommandAllowed like tool-workspace.ts's gitRaw does, but safely: args are always
// one of the two hardcoded arrays below (["config","--get","remote.origin.url"] or
// ["symbolic-ref",...]/["branch","--show-current"]), never job/tool input, so there is no
// attacker-controlled argv or ref reaching this call for the policy layer to screen. It still
// runs against a repo's own (untrusted) .git/config before that repo is enabled, so it applies
// the same hardening flags and restricted environment as every other internal Git invocation.
function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...GIT_HARDENING_ARGS, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: commandEnv(),
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}
