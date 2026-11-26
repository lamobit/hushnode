# Security Policy

## Supported versions

Security fixes are applied to the `main` branch. Older commits and forks are
not supported.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. If that is unavailable,
email `support@uin.app`.

Include the affected endpoint or component, the version or commit you tested,
reproduction steps, and the impact you believe is possible. We will acknowledge
the report and coordinate disclosure before any public write-up.

## Scope

HushNode is a read-only RAILGUN light index. It never handles spending keys or
mnemonics. The optional `/scan` endpoint accepts a shareable viewing key, so it
must only be enabled on self-hosted or explicitly trusted nodes.

Deployment hardening, TLS termination, rate limiting, and access logs are the
operator's responsibility; see [docs/security.md](docs/security.md).
