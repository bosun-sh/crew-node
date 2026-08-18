# Architecture

Crew Node is the only customer-installed Crew product. Crew Cloud owns Dashboard, Gateway, and the hosted Runner.

1. Dashboard creates a revocable install key containing its HTTPS URL.
2. Node exchanges that key for a short-lived session and registers with hosted Runner.
3. Node reports discovered repositories; an organization must explicitly enable one before work can target it.
4. Runner places bounded tool jobs in its durable queue. Node polls outbound, applies the intersection of host and job policy, and executes locally.
5. Node stores each result atomically before delivery. A restart or failed delivery resends the stored result without executing the job again.

The functional core parses untrusted payloads and computes effective policy. Effect modules own HTTP, filesystem, process, Git, audit, and durable-state operations. Dependencies used by the control loop are plain function values, keeping behavior testable without service containers or mutable global state.

Node listens only on loopback for `/healthz` and `/readyz`; it exposes no inbound execution API. Repository clones and credentials stay on the Node host. Requested source excerpts, diffs, command output, repository metadata, and tool results cross the outbound control-plane connection and may be sent to Crew Cloud's configured model provider.
