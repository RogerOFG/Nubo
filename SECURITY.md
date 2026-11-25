# Security

Report vulnerabilities privately through the repository's
[security advisories](https://github.com/RogerOFG/Nubo/security/advisories/new)
if private reporting is available. Include the Nubo version, operating system,
and the affected feature. Keep real credentials, meeting transcripts, and other
private data out of reports.

## Windows release verification

Compare the versioned installer's SHA-256 with the digest on its GitHub
release asset. The digest verifies the downloaded bytes against GitHub's
copy. It does not authenticate a Windows publisher.

When a trusted code-signing certificate is available in `CurrentUser\My`,
`scripts/pack-signed-windows.ps1` can sign the relay and installer. Set
`NUBO_SIGN_CERT_THUMBPRINT` to the certificate thumbprint. The script verifies
the pinned Sherpa ONNX archive, builds from the lockfile, and checks the
publisher and timestamp before copying versioned installers to `release/`.
The Windows SDK provides SignTool. If necessary, set
`TAURI_WINDOWS_SIGNTOOL_PATH` to its path.
