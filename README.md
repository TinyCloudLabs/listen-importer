# listen-importer

CLI importer for recorder disks such as MIC MINI. It scans mounted recorder media, clones audio into a local cache, indexes it in SQLite, then uploads media and metadata to TinyCloud for Listen using the `tc` CLI.

## Install

```sh
bun install
bun link
```

## Storage

Local state defaults to:

```text
~/.listen-importer/
  listen-importer.sqlite
  media/
```

Override it with `LISTEN_IMPORTER_HOME=/path/to/state`.

Remote defaults:

- TinyCloud profile: `tc` default profile
- Listen SQL db: `xyz.tinycloud.listen/conversations`
- Listen KV prefix: `xyz.tinycloud.listen`

## Usage

```sh
listen-importer init
listen-importer auth
listen-importer scan /Volumes/MIC\ MINI
listen-importer status
listen-importer upload
```

To insert placeholder Listen conversation rows for uploaded recordings:

```sh
listen-importer upload --publish
```

That makes recordings visible in Listen as `source = recorder` with audio metadata. The CLI does not transcribe audio by itself yet.

## Commands

```text
listen-importer init
listen-importer auth [--profile name] [--host url]
listen-importer permissions [--to did] [--expiry 30d]
listen-importer scan <path> [--recorder mic-mini|generic] [--dry-run]
listen-importer status [--json]
listen-importer upload [--limit n] [--publish] [--profile name] [--host url]
listen-importer list [--limit n]
listen-importer doctor
```

`permissions --to <did>` shells out to `tc delegation create` for the Listen KV prefix. SQL writes and direct uploads use your authenticated `tc` profile.

## Development

```sh
bun test
bun run check
bun run build
```
