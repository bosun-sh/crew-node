# Contributing

Crew Node favors a small functional core with effects kept at the filesystem, process, HTTP, and startup boundaries. Avoid new dependencies and abstractions unless they remove more complexity than they add.

Before opening a pull request:

```sh
bun install --frozen-lockfile
bun run check
docker build -t crew-node:local .
```

Add tests for protocol, policy, persistence, and security changes. Do not commit credentials, customer data, generated `dist`, or audit files. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
