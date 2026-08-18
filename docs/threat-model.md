# Threat model

## Protected assets

- Files and Git credentials outside the configured workspace.
- Sensitive files inside the workspace.
- Install and session credentials.
- Host-owned command, timeout, output, and write ceilings.
- Durable job results and audit integrity.

## Enforced boundaries

- Control-plane URLs require HTTPS except for loopback development.
- Input paths are relative, canonicalized, and checked beneath the workspace; final write and state targets do not follow symlinks.
- Cloud command lists are intersected with the host allowlist. Read-only jobs cannot invoke general executables or mutating Git operations.
- File, HTTP, subprocess, diff, search, and stored-result data are bounded before retention.
- Timed-out commands have their Linux process group killed, and partial bounded output is returned.
- Results are written privately and atomically before delivery; audit data is bounded and secret-redacted.

## Operator responsibilities and non-goals

Node is intentionally allowed to change explicitly enabled repositories. It is not a sandbox for hostile binaries already present in those repositories. Run it on a dedicated Linux host or VM, mount only approved repositories, keep the container unprivileged, and scope Git credentials narrowly. Crew Cloud and the configured model provider can receive context requested by approved work; Node does not provide end-to-end confidentiality from those services.
