# Crew Node

Crew Node is the open-source, customer-installed execution boundary for Crew Cloud. It discovers pre-cloned Git repositories and receives bounded tool jobs over an outbound-only connection. Repository clones and Git credentials remain on the customer host; selected file contents, diffs, command output, and metadata necessarily travel to Crew Cloud and its configured model provider when a job requests them.

`v0.2.0-beta.1` is a public paid-beta release. Its supported installation is the GHCR Linux container on amd64 or arm64.

## Trust boundary

- Node opens no public port. Its loopback-only HTTP server exists for local container health checks.
- Node initiates every control-plane connection over HTTPS (plain HTTP is accepted only for loopback development).
- A Dashboard-issued v2 install key bootstraps short-lived service sessions. Rotation or revocation blocks renewal.
- Cloud policy may narrow host command, timeout, output, and write limits but cannot broaden them.
- Paths are constrained to `CREW_WORKSPACE_ROOT` for the file tools (read, write, delete, outline, search) and for `run-command`'s working directory; symlink escape, sensitive reads, inline runtime evaluation, and dangerous Git global options are rejected. `run-command` does not inspect its argument list beyond the allowlisted program name, so an allowed command's own arguments (`sed -i /elsewhere`, `node ./repo-script.js`, `npm run <script>`) can still reach paths outside the workspace. The real mitigation for that gap is host-level: run the container `--read-only` with `--cap-drop=ALL` as shown below, and set `CREW_ALLOW_WRITES=false` on any host where writes are not required.
- Results are stored with private permissions before delivery and replayed after network or process failure without re-executing the job.
- Audit records contain metadata and bounded, secret-redacted diff previews. Command stdout/stderr contents are not written to the audit log. A failure's `failureReason` is diagnostic command/error text and passes through the same redaction as every other audit field, but by nature may still carry more of the underlying failure than other fields do.
- The live audit log rotates to a timestamped file at `CREW_AUDIT_MAX_BYTES`, and rotated files older than `CREW_AUDIT_RETENTION_DAYS` are deleted, so `/data` does not grow without bound. Rotated files are plain, secret-redacted JSONL: the export path for a compliance review is copying them off the mounted data volume (`docker cp`, or a backup of the `crew-node-data` volume), not a network endpoint.

Crew Node necessarily transmits requested context, runs approved commands, and writes approved files in enabled repositories. Install it on a dedicated Linux host or VM, expose only the repositories it may change, and scope SSH/Git credentials to those repositories. See the [architecture](docs/architecture.md) and [threat model](docs/threat-model.md) for the complete boundary.

## Install

Create a Node install in Crew Cloud, copy its one-time key, and prepare a directory containing the repositories Node may discover.

```sh
docker run -d --name crew-node --restart unless-stopped \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:size=64m,mode=1777 \
  -e CREW_NODE_API_KEY \
  -e CREW_WORKSPACE_ROOT=/workspace \
  -e CREW_AUDIT_DIR=/data/audit \
  -e CREW_STATE_DIR=/data/state \
  -v /srv/repos:/workspace \
  -v crew-node-data:/data \
  ghcr.io/bosun-sh/crew-node:0.2.0-beta.1
```

Do not publish container port 4321. After Node appears in Dashboard, explicitly enable each discovered repository before assigning work.

The equivalent hardened Compose example is in [`docker-compose.example.yml`](docker-compose.example.yml).

## Configuration

`CREW_NODE_API_KEY` is required and contains the Dashboard URL plus random bearer material. Optional controls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CREW_WORKSPACE_ROOT` | `/workspace` when present | Only filesystem tree jobs may access |
| `CREW_ALLOWED_COMMANDS` | `git,npm,node,sed,cat,ls,find,patch` | Host command ceiling |
| `CREW_ALLOW_WRITES` | `true` | Host write ceiling; `false` blocks writes even if Cloud requests them |
| `CREW_COMMAND_TIMEOUT_SECONDS` | `30` | Maximum command duration |
| `CREW_OUTPUT_MAX_BYTES` | `65536` | Maximum returned output per stream |
| `CREW_AUDIT_DIR` | `~/.crew-node/audit` | Append-only audit location |
| `CREW_AUDIT_MAX_BYTES` | `50000000` | Live audit log rolls to a timestamped file at this size |
| `CREW_AUDIT_RETENTION_DAYS` | `30` | Rotated audit files older than this are deleted; the live log is never pruned by age |
| `CREW_STATE_DIR` | `<audit>/state` | Durable undelivered job results |
| `CREW_PORT` | `4321` | Loopback health server port |

Request policy cannot raise the timeout or output ceilings configured here. General executables and mutating Git operations additionally require per-job write permission.

## Development

Requires Bun 1.3.9, Node.js 24, Git, and Docker for the image check.

```sh
bun install --frozen-lockfile
bun run check
docker build -t crew-node:local .
```

The implementation uses pure parsing, protocol, policy, and redaction functions around small filesystem, process, network, Git, audit, and persistence effect modules. `bun run check` enforces strict TypeScript, tests, builds, and the source-quality contract without a runtime framework.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements.
