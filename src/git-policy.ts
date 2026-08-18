// Git-specific policy: subcommand and post-subcommand argument allowlists, plus the hardening
// flags every internal Git invocation applies. Split out of policy.ts so each module stays a
// single, reviewable responsibility.

// Flags this codebase's own Git invocations rely on. `-c` global overrides stay denied for
// everyone (including internal callers) at the check step; these are injected into the spawned
// argv only after the check passes, so they never need to appear in an allowlisted argv.
export const GIT_HARDENING_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

// Option names this codebase's own Git invocations actually pass after the subcommand. Not a
// denylist: Git has far more exec/write-capable flags (-O, --output=, --upload-pack=, ...) than
// anyone could enumerate, so anything absent here is refused rather than trusted.
const GIT_ARGUMENT_ALLOWLIST = new Set([
  "--",
  "-A",
  "-b",
  "-m",
  "-n",
  "--abbrev-ref",
  "--cached",
  "--git-dir",
  "--name-only",
  "--no-ext-diff",
  "--no-verify",
  "--porcelain",
  "--quiet",
  "--short",
  "--stat",
  "--verify",
]);

const GIT_SUBCOMMAND_ALLOWLIST = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "rev-parse",
  "ls-files",
  "branch",
  "init",
  "apply",
  "merge-base",
  "blame",
  "grep",
  "checkout",
]);

const MUTATING_GIT_SUBCOMMANDS = new Set(["add", "apply", "branch", "checkout", "commit", "init"]);

// `push` is deliberately absent from GIT_SUBCOMMAND_ALLOWLIST, so this always denies it; the one
// legitimate push path (finalizeWorkspace's publish flow) bypasses this check entirely and is
// gated by checkPublishAllowed instead (see policy.ts).
export function checkGitInvocation(policy: { allowWrites: boolean }, argv: string[]): { allowed: boolean; reason?: string } {
  const subcommandIndex = argv.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
  const globalFlag = argv.slice(1, subcommandIndex < 0 ? undefined : subcommandIndex).find((arg) => arg !== "--no-pager");
  if (globalFlag) {
    return { allowed: false, reason: `git global option is denied: ${globalFlag}` };
  }
  const subcommand = subcommandIndex < 0 ? undefined : argv[subcommandIndex];
  if (!subcommand) {
    return { allowed: false, reason: "git requires an allowlisted subcommand." };
  }
  if (!GIT_SUBCOMMAND_ALLOWLIST.has(subcommand)) {
    return { allowed: false, reason: `git subcommand is not allowlisted: ${subcommand}` };
  }
  const badArgument = screenGitArguments(argv, subcommandIndex);
  if (badArgument) {
    return { allowed: false, reason: `git argument is not allowlisted: ${badArgument}` };
  }
  if (!policy.allowWrites && MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
    return { allowed: false, reason: `git ${subcommand} requires write permission.` };
  }
  return { allowed: true };
}

function screenGitArguments(argv: string[], subcommandIndex: number): string | undefined {
  for (let index = subcommandIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith("-")) continue;
    const name = arg.split("=")[0] as string;
    if (!GIT_ARGUMENT_ALLOWLIST.has(name)) return arg;
  }
  return undefined;
}
