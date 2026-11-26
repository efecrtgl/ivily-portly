# Installation

## Requirements

- Windows 10 (1809+) or Windows 11, x64
- Microsoft Edge WebView2 Runtime — preinstalled on Windows 11; the installer
  downloads it automatically on Windows 10 if missing
- No administrator rights required

## Installer (recommended)

1. Download `Ivily.Portly_<version>_x64-setup.exe` from
   [GitHub Releases](https://github.com/efecrtgl/ivily-portly/releases).
2. Optional but recommended: verify the checksum (see below).
3. Run the installer. It installs **per user** into
   `%LOCALAPPDATA%\Ivily Portly` and adds a Start menu entry. No UAC prompt.

Windows SmartScreen may warn about an unrecognized publisher because release
builds are not Authenticode-signed yet. Choose *More info → Run anyway* only
if the checksum matches.

### Verify the download

Each release includes `SHA256SUMS.txt`:

```powershell
Get-FileHash .\Ivily.Portly_0.1.0_x64-setup.exe -Algorithm SHA256
```

Compare the hash (case-insensitive) with the matching line in
`SHA256SUMS.txt`.

## Portable

`Ivily.Portly_<version>_x64_portable.zip` contains a single executable. Unzip
anywhere and run `Ivily Portly.exe`. The portable build does not update
itself.

## Updates

Installed builds check GitHub Releases for updates (Settings → Updates; can be
disabled). Updates are signed; Portly verifies the signature against the
public key built into the app and installs **only after you confirm**. The
installer upgrades in place.

## Your data during upgrades and uninstall

Data is stored in `%LOCALAPPDATA%\IvilyPortly`, outside the installation
folder:

- **Upgrades** keep all data. If a new version changes the database schema,
  a backup is written to `%LOCALAPPDATA%\IvilyPortly\backups` before migrating.
- **Uninstall** (Settings → Apps → Ivily Portly → Uninstall) removes the
  program. Your data folder is kept so a reinstall picks up where you left
  off. Delete `%LOCALAPPDATA%\IvilyPortly` manually to remove everything.

## Build from source

```powershell
git clone https://github.com/efecrtgl/ivily-portly
cd ivily-portly
npm ci
npm run tauri build
```

The installer is written to `src-tauri\target\release\bundle\nsis\`. Building
updater artifacts requires a signing key — see [RELEASING.md](RELEASING.md);
for a local build without one, remove `"createUpdaterArtifacts": true` from
`src-tauri/tauri.conf.json`.
