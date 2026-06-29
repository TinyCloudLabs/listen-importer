# listen

CLI importer for recorder disks such as MIC MINI. It scans mounted recorder media, clones audio into a local cache, indexes it in SQLite, then uploads media and metadata to TinyCloud for Listen using the `tc` CLI.

## Install

Requires Node.js 20.19 or newer.

```sh
npm install --global @tinycloud/listen-cli
```

After the package is published, the repo installer can also be used:

```sh
curl -fsSL https://raw.githubusercontent.com/TinyCloudLabs/listen-importer/main/scripts/install.sh | bash
```

Pass `--migrate` to move old local state from `~/.listen-importer` to
`~/.listen` during install.

## Storage

Local state defaults to:

```text
~/.listen/
  listen.sqlite
  media/
  downsampled/
  transcripts/
```

Override it with `LISTEN_HOME=/path/to/state`.

To migrate old local state:

```sh
listen migrate-state
```

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
`importer/transcripts`) and can be overridden via `LISTEN_MEDIA_KV_PATH`,
`LISTEN_METADATA_KV_PATH`, `LISTEN_TRANSCRIPT_KV_PATH`. The canonical app id is
`LISTEN_APP_ID` (default `xyz.tinycloud.listen`); SQL db and KV prefix derive
from it unless explicitly overridden. Override the app space with
`LISTEN_APP_SPACE`; publishing requires a `tc` CLI with `kv --space` and
`tc secrets doctor` support. This package pins the current
`@tinycloud/cli@0.7.0-beta.5` beta and prefers that local binary when available;
override with `LISTEN_TC_PATH`.

## Usage

```sh
listen init
listen auth
listen scan /Volumes/MIC\ MINI
listen scan-source voice-memos --since yesterday
listen scan-source voxterm
listen scan-source soundcore-sync --path ~/Documents/Soundcore-Transcripts
listen downsample --source voice_memos
listen transcribe --source voice_memos
listen status --source voice_memos
listen upload --publish --use-downsampled --source voice_memos
listen cleanup-recorder /Volumes/MIC\ MINI
```

Transcription prefers AssemblyAI, then falls back to Deepgram. The fastest way
to set the API key is through the secret manager web app:

<https://secrets.tinycloud.xyz/app?key=ASSEMBLYAI_API_KEY>

It pre-fills the secret name so you can just paste the value. `listen doctor`,
`listen transcribe`, and `listen permissions` all print this URL when the key
is missing.

Equivalent CLI flow:

```sh
tc secrets doctor ASSEMBLYAI_API_KEY
# If the doctor reports a missing network:
# tc secrets network init
tc secrets put ASSEMBLYAI_API_KEY "$ASSEMBLYAI_API_KEY"
listen permissions --grant
listen transcribe --source recorder
```

`--api-key`, `ASSEMBLYAI_API_KEY`, and `DEEPGRAM_API_KEY` still work for local
overrides. Use `--provider deepgram` to force Deepgram. Pass
`--secret-scope <name>` if you intentionally store transcription keys in a
scoped TinyCloud secret namespace.

`upload --publish` makes recordings visible in Listen as `source = recorder`. When a transcript exists locally, it is written into the `transcript_json` and `transcript_text` columns of the conversation row.

Downsampling is non-destructive. Originals stay in `media/`; smaller derived files are written to `downsampled/`. Transcription automatically prefers downsampled audio when it exists. Uploads use originals by default, or downsampled audio with `--use-downsampled`. Use `upload --publish --transcripts-only` when you only need Listen conversation rows with their transcripts.

Use `--source recorder`, `--source voice_memos`, `--source voxterm`, or `--source soundcore_sync` on `status`, `list`, `downsample`, `transcribe`, and `upload` to keep each import workflow scoped. Hyphenated aliases `voice-memos` and `soundcore-sync` are accepted for the snake-case Listen source values, and `--source all` is the default.

## Recorder cleanup

`cleanup-recorder` helps clear captured files from a mounted recorder after they are safely in the importer workflow. It is dry-run by default and only marks files eligible when they are tracked in the importer database and have a local transcript.

```sh
listen cleanup-recorder /Volumes/MIC\ MINI
listen cleanup-recorder /Volumes/MIC\ MINI --verbose
listen cleanup-recorder /Volumes/MIC\ MINI --delete --confirm "MIC MINI"
```

Use the recorder volume name as the `--confirm` value. For a MIC MINI mounted by macOS as `NO NAME`, the delete command is:

```sh
listen cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME"
```

Untranscribed or untracked files are blocked by default. To delete those too, the command requires both an explicit inclusion flag and an extra risky confirmation:

```sh
listen cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME" --include-untranscribed --confirm-risky delete-unverified
listen cleanup-recorder /Volumes/NO\ NAME --delete --confirm "NO NAME" --include-untracked --confirm-risky delete-unverified
```

`--include-untranscribed` means files are tracked locally but do not have a transcript yet. `--include-untracked` means files were found on the recorder but were not matched to the importer database.

## Local sources

`scan-source` imports local app libraries. If `--since` is omitted, the cutoff defaults to local midnight seven calendar days ago. The cutoff is inclusive.

```sh
listen scan-source voice-memos
listen scan-source voice-memos --since yesterday
listen scan-source voice-memos --since 2026-05-25
listen scan-source voice-memos --include-deleted
listen scan-source voxterm
listen scan-source voxterm --path ~/Documents/voxterm-transcripts
listen scan-source soundcore-sync
listen scan-source soundcore-sync --path ~/Documents/Soundcore-Transcripts
```

Voice Memos reads the macOS Voice Memos library directly and publishes as `source = voice_memos`. Deleted Voice Memos are skipped by default; pass `--include-deleted` to import them. It may require Full Disk Access for the terminal running the importer. VoxTerm reads saved markdown transcripts and publishes one Listen conversation per transcript file as `source = voxterm`. Soundcore Sync reads markdown files written by `tools/soundcore-sync` and publishes one transcript-only Listen conversation per file as `source = soundcore_sync`; by default it reads `~/Documents/Soundcore-Transcripts`, or `LISTEN_SOUNDCORE_SYNC_DIR` when set.

## Commands

```text
listen init
listen auth [--profile name] [--host url]
listen permissions [--grant] [--expiry 30d] [--secret-scope name]
listen scan <path> [--recorder mic-mini|generic] [--dry-run]
listen cleanup-recorder <path> [--recorder mic-mini|generic] [--delete] [--confirm volume-name] [--include-untranscribed] [--include-untracked] [--confirm-risky delete-unverified] [--json] [--verbose]
listen scan-source voice-memos|voxterm|soundcore-sync [--since yesterday|YYYY-MM-DD] [--path path] [--include-deleted] [--dry-run]
listen status [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--json]
listen list [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all]
listen downsample [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--format mp3|m4a|wav] [--bitrate 64k] [--sample-rate 16000] [--force]
listen transcribe [--limit n] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--provider assemblyai|deepgram] [--api-key key] [--secret-scope name] [--force]
listen upload [--limit n] [--publish] [--use-downsampled] [--transcripts-only] [--source recorder|voice_memos|voxterm|soundcore_sync|all] [--profile name] [--host url]
listen migrate-state [--from path] [--to path] [--dry-run]
listen doctor [--secret-scope name]
```

`permissions --grant` shells out to `tc auth request --grant` for Listen KV/SQL
capabilities and runs `tc secrets doctor ASSEMBLYAI_API_KEY` to verify the
TinyCloud secrets permission path for `ASSEMBLYAI_API_KEY`. SQL writes and
direct uploads use your authenticated `tc` profile.

`doctor` checks local state, TinyCloud auth, environment transcription keys, the
default TinyCloud secrets encryption network, and whether `ASSEMBLYAI_API_KEY`
is readable from the configured TinyCloud secrets scope. It uses
`tc secrets doctor` and only suggests `tc secrets network init` when the network
is missing or unreadable.

## Development

```sh
npm install
npm test
npm run check
npm run build
```
