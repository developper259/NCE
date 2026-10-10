# Security

If you discover a potential security vulnerability in NCE, please report it privately.

**Do not disclose security vulnerabilities through public GitHub Issues, Discussions, or pull requests before coordinated disclosure.**

To submit a report:

1. Visit the NCE repository on GitHub.
2. Open the **Security** section.
3. Select **Report a vulnerability**, if private vulnerability reporting is enabled.
4. Provide enough information for the maintainers to investigate the issue.

If private reporting is unavailable, request a private security contact without publishing exploit details.

## What to Include

A useful vulnerability report should contain:

- A clear description of the issue.
- The affected NCE version.
- Your operating system and architecture.
- Steps to reproduce the vulnerability.
- The potential security impact.
- A proof of concept, if available.
- Any suggested mitigation or fix.

Please avoid sharing real credentials, access tokens, personal files, or other sensitive information.

## Security Scope

Relevant security issues may include:

- Electron IPC and preload vulnerabilities.
- Renderer sandbox or context-isolation bypasses.
- Unauthorized filesystem access or modification.
- Path traversal vulnerabilities.
- Unexpected command execution.
- Terminal process management vulnerabilities.
- Dependency and native module vulnerabilities.
- Exposure of sensitive data.

Commands explicitly entered and executed by the user in the integrated terminal are not, by themselves, security vulnerabilities.

## Disclosure Process

Maintainers will review reports and investigate reproducible security issues.

Confirmed vulnerabilities may be addressed through patches, dependency updates, or other appropriate mitigations.

As NCE is still in beta, no fixed response or resolution timeframe is guaranteed.

Please allow time for investigation and remediation before publicly disclosing vulnerability details.

## Responsible Research

Security research is welcome when conducted responsibly.

Please:

- Test only systems and data you own or are authorized to access.
- Avoid disrupting services or damaging data.
- Do not access or disclose other users' information.
- Report findings privately and provide reproducible details.

Thank you for helping make NCE more secure.