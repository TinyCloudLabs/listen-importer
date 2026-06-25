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
  downsampled/
  transcripts/
```

Override it with `LISTEN_IMPORTER_HOME=/path/to/state`.

Remote defaults:

- TinyCloud profile: `tc` default profile
- Listen SQL db: `xyz.tinycloud.listen/conversations`
- Listen KV prefix: `xyz.tinycloud.listen`
- Listen app space: `applications`

Listen is a manifest app. Published conversation rows and participant rows are
written to the `applications` space so Listen and Feed read the same canonical
data. Transcripts are stored in the `conversation.transcript_json` and
`conversation.transcript_text` columns directly — there is no separate
`transcript/{conversationId}` KV blob. If a fresh DB does not yet have those
columns, run `scripts/migrate-transcript-columns.sh` once.

Importer media and per-recording metadata blobs are still written to KV under
configurable scoped paths (defaults: `importer/media`, `importer/metadata`,
`importer/transcripts`) and can be overridden via `LISTEN_IMPORTER_MEDIA_KV_PATH`,
`LISTEN_IMPORTER_METADATA_KV_PATH`, `LISTEN_IMPORTER_TRANSCRIPT_KV_PATH`. The
canonical app id is `LISTEN_IMPORTER_APP_ID` (default `xyz.tinycloud.listen`);
SQL db and KV prefix derive from it unless explicitly overridden. Override the
app space with `LISTEN_IMPORTER_APP_SPACE`; publishing requires a `tc` CLI
with `kv --space` support. This package pins `@tinycloud/cli@0.6.0` and prefers
that local binary when available; override with `LISTEN_IMPORTER_TC_PATH`.

## Usage

```sh
listen-importer init
listen-importer auth
listen-importer scan /Volumes/MIC\ MINI
listen-importer scan-source voice-memos --since yesterday
listen-importer scan-source voxterm
listen-importer scan-source soundcore-sync --path ~/Documents/Soundcore-Transcripts
listen-importer preprocess --source voice_memos
listen-importer transcribe --source voice_memos --provider assemblyai
listen-importer status --source voice_memos
listen-importer upload --publish --use-downsampled --source voice_memos
listen-importer cleanup-recorder /Volumes/MIC\ MINI
```

Transcription uses Deepgram or AssemblyAI:

```sh
DEEPGRAM_API_KEY=... listen-importer transcribe --provider deepgram
ASSEMBLYAI_API_KEY=... listen-importer transcribe --provider assemblyai
```

`upload --publish` makes recordings visible in Listen as `source = recorder`. When a transcript exists locally, it is written into the `transcript_json` and `transcript_text` columns of the conversation row.

Downsampling is non-destructive. Originals stay in `media/`; smaller derived files are written to `downsampled/`. Transcription automatically prefers downsampled audio when it exists. Uploads use originals by default, or downsampled audio with `--use-downsampled`. Use `upload --publish --transcripts-only` when you only need Listen conversation rows with their transcripts.

Use `--source recorder`, `--source voice_memos`, `--source voxterm`, or `--source soundcore_sync` on `status`, `list`, `preprocess`, `downsample`, `transcribe`, and `upload` to keep each import workflow scoped. Hyphenated aliases `voice-memos` and `soundcore-sync` are accepted for the snake-case Listen source values, and `--source all` is the default.

## Recorder cleanup

`cleanup-recorder` helps clear captured files from a mounted recorder after they are safely in the importer workflow. It is dry-run by default and only marks files eligible when they are tracked in the importer database and have a local transcript.

```sh
listen-importer cleanup-recorder /Volumes/MIC\ MINI
listen-importer cleanup-recorder /Volumes/MIC\ MINI --verbose
listen-importer cleanup-recorder /Volumes/MIC\ MINI --delete --confirm "MIC MINI"
```

Use the recorder volume name as the `--confirm` value. For a MIC MINI mounted by macOS as `NO NAME`, the delete command is:

```sh
listen-importer cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME"
```

Untranscribed or untracked files are blocked by default. To delete those too, the command requires both an explicit inclusion flag and an extra risky confirmation:

```sh
listen-importer cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME" --include-untranscribed --confirm-risky delete-unverified
listen-importer cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME" --include-untracked --confirm-risky delete-unverified
```

`--include-untranscribed` means files are tracked locally but do not have a transcript yet. `--include-untracked` means files were found on the recorder but were not matched to the importer database.

## Local sources

`scan-source` imports local app libraries. If `--since` is omitted, the cutoff defaults to local midnight seven calendar days ago. The cutoff is inclusive.

```sh
listen-importer scan-source voice-memos
listen-importer scan-source voice-memos --since yesterday
listen-importer scan-source voice-memos --since 2026-05-25
listen-importer scan-source voice-memos --include-deleted
listen-importer scan-source voxterm
listen-importer scan-source voxterm --path ~/Documents/voxterm-transcripts
listen-importer scan-source soundcore-sync
listen-importer scan-source soundcore-sync --path ~/Documents/Soundcore-Transcripts
```

Voice Memos reads the macOS Voice Memos library directly and publishes as `source = voice_memos`. Deleted Voice Memos are skipped by default; pass `--include-deleted` to import them. It may require Full Disk Access for the terminal running the importer. VoxTerm reads saved markdown transcripts and publishes one Listen conversation per transcript file as `source = voxterm`. Soundcore Sync reads markdown files written by `tools/soundcore-sync` and publishes one transcript-only Listen conversation per file as `source = soundcore_sync`; by default it reads `~/Documents/Soundcore-Transcripts`, or `LISTEN_IMPORTER_SOUNDCORE_SYNC_DIR` when set.

## Commands

```text
listen-importer init
listen-importer auth [--profile name] [--host url]
listen-importer permissions [--to did] [--expiry 30d]
listen-importer scan <path> [--recorder mic-mini|generic] [--dry-run]
listen-importer cleanup-recorder <path> [--recorder mic-mini|generic] [--delete] [--confirm volume-name] [--include-untranscribed] [--include-untracked] [--confirm-risky delete-unverified] [--json] [--verbose]
listen-importer scan-source voice-memos|voxterm|soundcore-sync [--since yesterday|YYYY-MM-DD] [--path path] [--include-deleted] [--dry-run]
listen-importer status [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--json]
listen-importer list [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all]
listen-importer preprocess [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
listen-importer downsample [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
listen-importer transcribe [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--provider deepgram|assemblyai] [--api-key key] [--force]
listen-importer upload [--limit n] [--publish] [--use-downsampled] [--transcripts-only] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--profile name] [--host url]
listen-importer doctor
```

`permissions --to <did>` shells out to `tc delegation create` for the Listen KV prefix. SQL writes and direct uploads use your authenticated `tc` profile.

## Development

```sh
bun test
bun run check
bun run build
```
