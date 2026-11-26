# Versioning strategy

Portly follows [Semantic Versioning 2.0](https://semver.org).

| Change | Bump (≥ 1.0) | Bump while 0.x |
|---|---|---|
| Incompatible change to data formats, export format or IEP major | MAJOR | MINOR |
| New features, new IEP capabilities, additive schema migrations | MINOR | MINOR |
| Fixes, performance, docs | PATCH | PATCH |

Pre-releases use a suffix (`0.2.0-beta.1`) and are published as GitHub
pre-releases.

## Single source of truth

- `package.json` `version` is authoritative.
- `src-tauri/tauri.conf.json` reads it (`"version": "../package.json"`).
- `src-tauri/Cargo.toml` must match — `scripts/check-version.ps1` enforces
  this in CI and in the release workflow, together with a matching
  `CHANGELOG.md` section and (for releases) the git tag `vX.Y.Z`.

## Independent version lines

| Item | Where | Policy |
|---|---|---|
| App version | `package.json` | SemVer as above |
| Database schema | `SCHEMA_VERSION` in `src-tauri/src/db/schema.rs` | Integer, append-only migrations, backup before upgrade, newer schemas never modified |
| Export format | `exchange::VERSION` | Integer; importers accept 1…current |
| IEP protocol | `iep::PROTOCOL_VERSION` | SemVer; see [IEP.md](IEP.md#compatibility) |

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). Every
user-facing change goes under **Unreleased**; the release commit renames it to
the new version and date. The release workflow publishes that section as the
release notes.
