# Security policy

## Supported versions

Only the latest minor release receives security fixes during the paid beta.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting for `bosun-sh/crew-node`. If that is unavailable, email `team@bosun.sh` with the affected version, impact, reproduction steps, and any proposed mitigation.

We will acknowledge a report within three business days and coordinate disclosure after a fix is available. Never include real customer credentials or source code in a report.

## Scope

The security boundary and deliberate host capabilities are documented in the README. A report is especially useful when untrusted job data can escape `CREW_WORKSPACE_ROOT`, bypass command policy, disclose credentials, execute a job more than once after redelivery, or expose an inbound network surface.
