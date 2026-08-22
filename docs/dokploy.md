# Dokploy Dockerfile deployment

Crew Node already ships with a production `Dockerfile` at the repository root.
For a single customer Node, use a Dokploy **Application** backed by this
Dockerfile. Do not expose a public Node port.

## Create the application

1. Create a Dokploy Project and choose **Application**.
2. Select the Git repository `bosun-sh/crew-node` and branch `main`.
3. Set build type to **Dockerfile**.
4. Use repository root as the build context and `Dockerfile` as the file.
5. Leave the public domain/port unset. Node only makes outbound connections;
   its HTTP listener is loopback-only for health checks.

## Environment variables

Add these Application environment variables in Dokploy:

```dotenv
CREW_NODE_API_KEY=<Dashboard one-time install key>
CREW_WORKSPACE_ROOT=/workspace
CREW_AUDIT_DIR=/data/audit
CREW_STATE_DIR=/data/state
HOME=/tmp/crew
NPM_CONFIG_CACHE=/tmp/crew/.npm
```

Optional ceilings can be added explicitly:

```dotenv
CREW_ALLOWED_COMMANDS=git,npm,node,sed,cat,ls,find,patch
CREW_COMMAND_TIMEOUT_SECONDS=120
CREW_OUTPUT_MAX_BYTES=80000
CREW_ALLOW_WRITES=true
```

## Mounts and runtime settings

Configure these Dokploy mounts:

| Host path | Container path | Mode |
| --- | --- | --- |
| `/srv/repos` | `/workspace` | read/write |
| Named volume `crew-node-data` | `/data` | read/write |

Set the container to:

- restart always/unless stopped
- read-only filesystem
- drop all Linux capabilities
- enable `no-new-privileges`
- mount a writable `/tmp` tmpfs of at least 64 MB

The workspace mount must be a VPS path, not a path inside Dokploy's Git
checkout. Dokploy replaces that checkout during deployments.

## Start and verify

1. On the VPS, create `/srv/repos` and put only approved, pre-cloned Git
   repositories inside it.
2. Ensure the container's unprivileged user can write the repositories that
   Crew is allowed to modify.
3. Deploy the Application in Dokploy.
4. Check the Application logs for the outbound bootstrap and heartbeat.
5. Confirm health locally from the container:

   ```sh
   docker exec <container-name> node -e \
     'fetch("http://127.0.0.1:4321/healthz").then(r=>process.exit(r.ok?0:1))'
   ```

6. In Crew Dashboard → **Work**, wait for the Node and repositories to appear
   online, then explicitly enable the repository.

## Todo smoke test

Create a disposable repository at `/srv/repos/todo-app` with at least one
initial Git commit. In Dashboard → **Work**, create a task with:

- Policy: `package-install`
- Max iterations: `8`
- A reviewed credit cap

Use a prompt such as:

```text
Build a small Todo list app in this repository. Add create, complete, delete,
and all/active/completed filters. Follow the existing stack; if the repository
is empty, use a minimal npm-compatible implementation. Run the available tests
or build before finishing, keep changes inside this repository, and report the
verification command and result.
```

The Runner performs the work within the cap, but the paid-beta flow still
requires budget confirmation and final human review.
