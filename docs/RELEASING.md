# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a
`vX.Y.Z` tag is pushed. The workflow creates a **draft** release; a maintainer
reviews and publishes it.

## One-time setup: updater signing key

Update bundles are signed with a minisign key. The public key is embedded in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private key is
**never committed**.

Add two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's password |

Back the key and password up securely. **If the key is lost**, existing
installations can't verify new updates automatically; a new key must be
generated and users must install one release manually:

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\ivily-portly.key"
```

Then put the new `.key.pub` content into `plugins.updater.pubkey`.

## Release checklist

1. Make sure `main` is green in CI.
2. Bump the version in `package.json` and `src-tauri/Cargo.toml`, run
   `cargo check` (updates `Cargo.lock`) and `npm install` (updates
   `package-lock.json`).
3. Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`
   and add a fresh empty Unreleased section.
4. `./scripts/check-version.ps1` must pass.
5. Commit (`chore: release vX.Y.Z`), tag and push:
   ```powershell
   git tag -a vX.Y.Z -m "Ivily Portly vX.Y.Z"
   git push origin main vX.Y.Z
   ```
6. Watch the **Release** workflow. It verifies versions, runs lint and tests,
   builds the NSIS installer, signs the updater bundle, checks the installer,
   signature and embedded version (including via `--iep describe`), and
   uploads the installer, `latest.json`, a portable zip and `SHA256SUMS.txt`
   to a draft release with notes taken from the changelog.
7. Review the draft (assets present, checksums listed, notes correct) and
   publish it. Publishing makes `releases/latest/download/latest.json`
   available, which installed apps use for update detection.

## Artifacts

| File | Purpose |
|---|---|
| `Ivily.Portly_X.Y.Z_x64-setup.exe` | Per-user NSIS installer |
| `Ivily.Portly_X.Y.Z_x64-setup.exe.sig` | Updater signature |
| `latest.json` | Updater manifest |
| `Ivily.Portly_X.Y.Z_x64_portable.zip` | Portable executable |
| `SHA256SUMS.txt` | SHA-256 of every asset above |
