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

## Usage

```sh
listen-importer init
listen-importer auth
listen-importer scan /Volumes/MIC\ MINI
listen-importer scan-source voice-memos --since yesterday
listen-importer scan-source voxterm
listen-importer preprocess --source voice_memos
listen-importer transcribe --source voice_memos --provider assemblyai
listen-importer status --source voice_memos
listen-importer upload --publish --use-downsampled --source voice_memos
```

Transcription uses Deepgram or AssemblyAI:

```sh
DEEPGRAM_API_KEY=... listen-importer transcribe --provider deepgram
ASSEMBLYAI_API_KEY=... listen-importer transcribe --provider assemblyai
```

`upload --publish` makes recordings visible in Listen as `source = recorder`. When a transcript exists locally, it writes that transcript to the Listen transcript KV path for the conversation.

Downsampling is non-destructive. Originals stay in `media/`; smaller derived files are written to `downsampled/`. Transcription automatically prefers downsampled audio when it exists. Uploads use originals by default, or downsampled audio with `--use-downsampled`. Use `upload --publish --transcripts-only` when you only need Listen conversation rows and transcript blobs.

Use `--source recorder`, `--source voice_memos`, or `--source voxterm` on `status`, `list`, `preprocess`, `downsample`, `transcribe`, and `upload` to keep each import workflow scoped. `voice-memos` is accepted as an alias for `voice_memos`, and `--source all` is the default.

## Local sources

`scan-source` imports local app libraries. If `--since` is omitted, the cutoff defaults to local midnight seven calendar days ago. The cutoff is inclusive.

```sh
listen-importer scan-source voice-memos
listen-importer scan-source voice-memos --since yesterday
listen-importer scan-source voice-memos --since 2026-05-25
listen-importer scan-source voice-memos --include-deleted
listen-importer scan-source voxterm
listen-importer scan-source voxterm --path ~/Documents/voxterm-transcripts
```

Voice Memos reads the macOS Voice Memos library directly and publishes as `source = voice_memos`. Deleted Voice Memos are skipped by default; pass `--include-deleted` to import them. It may require Full Disk Access for the terminal running the importer. VoxTerm reads saved markdown transcripts and publishes one Listen conversation per transcript file as `source = voxterm`.

## Commands

```text
listen-importer init
listen-importer auth [--profile name] [--host url]
listen-importer permissions [--to did] [--expiry 30d]
listen-importer scan <path> [--recorder mic-mini|generic] [--dry-run]
listen-importer scan-source voice-memos|voxterm [--since yesterday|YYYY-MM-DD] [--path path] [--include-deleted] [--dry-run]
listen-importer status [--source recorder|voice_memos|voxterm|all] [--json]
listen-importer list [--limit n] [--source recorder|voice_memos|voxterm|all]
listen-importer preprocess [--limit n] [--source recorder|voice_memos|voxterm|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
listen-importer downsample [--limit n] [--source recorder|voice_memos|voxterm|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
listen-importer transcribe [--limit n] [--source recorder|voice_memos|voxterm|all] [--provider deepgram|assemblyai] [--api-key key] [--force]
listen-importer upload [--limit n] [--publish] [--use-downsampled] [--transcripts-only] [--source recorder|voice_memos|voxterm|all] [--profile name] [--host url]
listen-importer doctor
```

`permissions --to <did>` shells out to `tc delegation create` for the Listen KV prefix. SQL writes and direct uploads use your authenticated `tc` profile.

## Development

```sh
bun test
bun run check
bun run build
```
