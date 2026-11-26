# Data management

## Location

All data lives in `%LOCALAPPDATA%\IvilyPortly`:

| Path | Content |
|---|---|
| `portly.db` | SQLite database (WAL mode) |
| `backups/` | Automatic and manual backups (`*.db`) |
| `portly.corrupt-<timestamp>.db` | A database that failed its integrity check (kept, never deleted) |

The folder is separate from the installation directory, so installing,
upgrading or uninstalling Portly does not touch it. Delete the folder manually
to remove all data.

## What is stored

Projects, project ports, groups, profiles, port labels/notes/favorites,
personal reservations, custom ranges, port plans, settings, the activity
history, server health samples (on status change, at most one per port every
5 minutes) and the last 20 inspected processes. Executable paths are **not**
stored in history unless "Store executable paths" is enabled.

## Schema migrations

- `PRAGMA user_version` holds the schema version; migrations in
  `src-tauri/src/db/schema.rs` run in order, each in its own transaction.
- **Before migrating** an existing database to a newer schema, Portly writes a
  full copy to `backups/portly-pre-v<N>-<timestamp>.db` (`VACUUM INTO`).
- A database created by a **newer** Portly is never modified. The app runs on
  an in-memory database for that session and shows a banner asking to update.
- Released migrations are never edited; new ones are appended.

## Integrity and recovery

On every start Portly runs `PRAGMA quick_check`. A failing database is moved
to `portly.corrupt-<timestamp>.db` (with its WAL/SHM files) and a fresh one is
created; the UI reports what happened and where the old file is. If the
database can't be opened at all, Portly runs without persistence for that
session and says so.

## Backup and restore

- **Back up now** (Settings → Data) writes a consistent snapshot to
  `backups/`.
- **Restore** accepts only a readable SQLite file that passes `quick_check`,
  has a supported schema version and contains Portly's tables. The current
  database is backed up to `backups/portly-before-restore-<timestamp>.db`
  first; migrations then run on the restored data.

## Import / export

Settings → Import/Export uses the `ivily-portly-export` JSON format
(version 1):

- References between records use **names**, so exports move between
  machines.
- **Merge** skips records whose names already exist; **Replace** wipes the
  configuration (after an automatic backup) and imports everything.
- Every record passes the same validation as the UI; invalid records are
  skipped and listed in the import report. Project directories that don't
  exist on the target machine are cleared with a warning.
- Files over 10 MB are rejected.
- Settings are included only when chosen on export and applied only when
  chosen on import.

Port plans can also be exported individually as JSON, CSV (with spreadsheet
formula neutralization) or Markdown.

## Retention and privacy

Settings → History & privacy controls whether history is recorded, how long
events are kept (1–365 days, default 30), the maximum number of events
(default 20,000), whether events are recorded for every port or only for
ports you care about, and whether executable paths are stored. Retention is
applied hourly and immediately when changed. The Activity Center can clear
filtered or all events.
