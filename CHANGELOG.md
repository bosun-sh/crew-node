# Changelog

## 0.2.0-beta.1

- Replaced the legacy inbound executor with an outbound-only Dashboard and Runner control plane.
- Added durable, atomic result delivery and restart-safe job deduplication.
- Restricted health checks to loopback and hardened URL, path, Git command, audit, and container boundaries.
- Standardized builds on Bun 1.3.9 and Node.js 24.
- Added GHCR multi-architecture releases, provenance attestations, CodeQL, and dependency updates.
- Enforced host-owned timeout, output, command, and write ceilings with bounded I/O and process-tree cleanup.
- Documented the exact customer-host and Cloud data boundary for the public paid beta.
- Attempted a full Rust rewrite of Crew Node and reverted it, restoring the TypeScript runtime.
- **Breaking default change:** `CREW_AUDIT_DIR` now defaults to `~/.crew-node/audit` instead of
  `<workspace>/.crew-audit`, so the audit trail (and its derived default `CREW_STATE_DIR`) can
  never live under a path a job's own file tools can reach. Operators relying on the old default
  location should set `CREW_AUDIT_DIR` explicitly to keep reading audit logs from the workspace,
  or move existing logs to the new default path.
- Extracted Git subcommand allowlisting into `git-policy.ts` and added post-subcommand argument
  allowlisting, closing argument-injection vectors (e.g. `grep -O`, `diff --output=`) that a bare
  subcommand check let through.
- Applied the same hardening flags (`core.hooksPath=/dev/null`, `core.fsmonitor=`) and restricted
  environment to every internal Git invocation, and added `safeRef`/`isSafeBranch` validation so a
  caller-supplied `baseRef` or branch name can no longer reach a Git argv unchecked.
- File writes and deletes now refuse sensitive paths (`.env`, SSH keys, credential files, etc.)
  instead of only redacting their contents in output.
- Added an explicit `allowPublish` policy flag, separately gated from `allowWrites`, for the one
  path that pushes a Crew run branch to its remote.
- Job policy payloads now reject unknown/unsupported fields instead of silently ignoring typos.
- Corrupted or unreadable durable job results are quarantined (renamed aside) instead of crashing
  the read path or permanently blocking the job's result slot.
- Control-plane session health (auth failures, stale heartbeats) is now tracked and surfaced
  through `/readyz`.
- Added `.git/` to the sensitive-path patterns used for redaction and write protection.
- **Fixed:** the audit log's secret redaction ran after `JSON.stringify`, whose quote-escaping let
  a quoted generic secret (e.g. `TOKEN="abcdef123456"`) slip past the redaction pattern. Redaction
  now runs per-string via `JSON.stringify`'s replacer, before escaping, at any nesting depth.
- Added a host-side write ceiling: `CREW_ALLOW_WRITES` (default `true`) lets an operator disable
  writes entirely, independent of what policy a job requests.
- Hardened repository discovery's own Git invocations with the same hardening flags and restricted
  environment as every other internal Git call, since they run against a repo's own `.git/config`
  before that repo is enabled.
- Removed an unreachable `sed -i` write-permission guard: `sed` was never in the read-only command
  set, so the general write check already denied it first.
- Removed the unused `bin/crew-node` npm scaffolding; the container image is the only supported
  install path and never invoked it.
