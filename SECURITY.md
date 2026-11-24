# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub Security
Advisories:

https://github.com/jrxid09-design/Damar/security/advisories/new

Do not open a public issue, discussion, or pull request for a
vulnerability, and please do not disclose details publicly until a fix is
available and the report has been coordinated with the maintainers.

A useful report includes:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The version or commit you tested
- A suggested fix, if you have one

We aim to acknowledge new reports within one week. DAMAR is a pre-1.0
project maintained by a small team, so fix timelines are best-effort and
depend on severity; we will keep you updated as the report progresses.

## Supported versions

DAMAR has not reached a stable 1.0 release yet. Security fixes are applied
to the latest state of the `develop` branch and, once published, to the
most recent release build. Older snapshots and pre-release builds are not
supported.

## Scope notes

DAMAR's product security model — what runs with your rights, permission
prompts, data locations, and how to revoke access — is documented in
[apps/desktop/release/docs/SECURITY.md](apps/desktop/release/docs/SECURITY.md).
Behavior that matches that documentation is usually better suited to
GitHub Discussions; a way to *bypass* the model belongs in a private
advisory.
