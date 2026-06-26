import { mkdir, writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { ImporterStore, RecordingRow } from "./db";
import { audioSourceFor } from "./downsample";
import type { ListenSource } from "./listen-source";
import { getSecret, type TcOptions } from "./tc";

export type TranscriptionProvider = "deepgram" | "assemblyai";

export interface TranscriptSegment {
  speaker_name: string;
  text: string;
  start_time: number | null;
  end_time: number | null;
  language?: string | null;
}

export interface NormalizedTranscript {
  provider: TranscriptionProvider;
  providerJobId: string | null;
  text: string;
  segments: TranscriptSegment[];
  durationSecs: number | null;
}

export interface TranscribeOptions {
  provider?: TranscriptionProvider;
  apiKey?: string;
  limit?: number;
  force?: boolean;
  model?: string;
  language?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  listenSource?: ListenSource;
  secretScope?: string;
  tcOptions?: TcOptions;
}

export interface TranscribeResult {
  transcribed: number;
  failed: number;
}

interface DeepgramUtterance {
  transcript?: string;
  start?: number;
  end?: number;
  speaker?: number;
  language?: string;
}

interface AssemblyUtterance {
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
}

const DEFAULT_DEEPGRAM_MODEL = "nova-3";
const DEFAULT_ASSEMBLY_SPEECH_MODELS = ["universal-3-pro", "universal-2"];
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function transcribePending(
  config: AppConfig,
  store: ImporterStore,
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const rows = store.pendingTranscription(
    options.limit ?? 25,
    Boolean(options.force),
    options.listenSource,
  );
  const result: TranscribeResult = { transcribed: 0, failed: 0 };
  if (rows.length === 0) return result;

  const { provider, apiKey } = resolveProvider(config, options);

  for (const row of rows) {
    try {
      const transcript =
        provider === "deepgram"
          ? await transcribeWithDeepgram(row, apiKey, options)
          : await transcribeWithAssemblyAI(row, apiKey, options);
      const transcriptPath = await saveTranscript(
        config,
        row,
        transcript.segments,
      );
      store.markTranscribed(row.id, {
        provider,
        transcriptPath,
        transcriptText: transcript.text,
        durationSecs: transcript.durationSecs,
      });
      result.transcribed += 1;
    } catch (err) {
      result.failed += 1;
      store.markTranscriptionFailed(
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

export function normalizeDeepgramResponse(raw: unknown): NormalizedTranscript {
  const data = raw as {
    metadata?: { request_id?: string; duration?: number };
    results?: {
      utterances?: DeepgramUtterance[];
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{ start?: number; end?: number }>;
        }>;
      }>;
    };
  };

  const utterances = data.results?.utterances ?? [];
  if (utterances.length > 0) {
    const segments = utterances
      .map((utterance) => ({
        speaker_name:
          typeof utterance.speaker === "number"
            ? `Speaker ${utterance.speaker + 1}`
            : "Unknown",
        text: (utterance.transcript ?? "").trim(),
        start_time: toNullableNumber(utterance.start),
        end_time: toNullableNumber(utterance.end),
        language: utterance.language ?? null,
      }))
      .filter((segment) => segment.text.length > 0);

    return {
      provider: "deepgram",
      providerJobId: data.metadata?.request_id ?? null,
      text: segments.map((segment) => segment.text).join("\n"),
      segments,
      durationSecs:
        maxEndTime(segments) ?? toNullableNumber(data.metadata?.duration),
    };
  }

  const alternative = data.results?.channels?.[0]?.alternatives?.[0];
  const text = (alternative?.transcript ?? "").trim();
  const words = alternative?.words ?? [];
  const start = words[0]?.start;
  const end = words[words.length - 1]?.end;
  const segments = text
    ? [
        {
          speaker_name: "Unknown",
          text,
          start_time: toNullableNumber(start),
          end_time: toNullableNumber(end),
        },
      ]
    : [];

  return {
    provider: "deepgram",
    providerJobId: data.metadata?.request_id ?? null,
    text,
    segments,
    durationSecs:
      maxEndTime(segments) ?? toNullableNumber(data.metadata?.duration),
  };
}

export function normalizeAssemblyAIResponse(
  raw: unknown,
): NormalizedTranscript {
  const data = raw as {
    id?: string;
    text?: string;
    audio_duration?: number;
    utterances?: AssemblyUtterance[];
  };
  const utterances = data.utterances ?? [];
  const segments = utterances
    .map((utterance) => ({
      speaker_name: utterance.speaker
        ? `Speaker ${utterance.speaker}`
        : "Unknown",
      text: (utterance.text ?? "").trim(),
      start_time: millisToSeconds(utterance.start),
      end_time: millisToSeconds(utterance.end),
    }))
    .filter((segment) => segment.text.length > 0);

  const fallbackText = (data.text ?? "").trim();
  const finalSegments =
    segments.length > 0 || fallbackText.length === 0
      ? segments
      : [
          {
            speaker_name: "Unknown",
            text: fallbackText,
            start_time: null,
            end_time: toNullableNumber(data.audio_duration),
          },
        ];

  return {
    provider: "assemblyai",
    providerJobId: data.id ?? null,
    text:
      finalSegments.map((segment) => segment.text).join("\n") || fallbackText,
    segments: finalSegments,
    durationSecs:
      maxEndTime(finalSegments) ?? toNullableNumber(data.audio_duration),
  };
}

async function transcribeWithDeepgram(
  row: RecordingRow,
  apiKey: string,
  options: TranscribeOptions,
): Promise<NormalizedTranscript> {
  const params = new URLSearchParams({
    model: options.model ?? DEFAULT_DEEPGRAM_MODEL,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
  });
  if (options.language) params.set("language", options.language);
  const audio = audioSourceFor(row, true);
  const audioBlob = await openAsBlob(audio.path, { type: audio.contentType });

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": audio.contentType,
      },
      body: audioBlob,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Deepgram transcription failed: ${response.status} ${await response.text()}`,
    );
  }

  return normalizeDeepgramResponse(await response.json());
}

async function transcribeWithAssemblyAI(
  row: RecordingRow,
  apiKey: string,
  options: TranscribeOptions,
): Promise<NormalizedTranscript> {
  const audio = audioSourceFor(row, true);
  const audioBlob = await openAsBlob(audio.path, {
    type: "application/octet-stream",
  });
  const upload = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: audioBlob,
  });

  if (!upload.ok) {
    throw new Error(
      `AssemblyAI upload failed: ${upload.status} ${await upload.text()}`,
    );
  }

  const uploadBody = (await upload.json()) as { upload_url?: string };
  if (!uploadBody.upload_url)
    throw new Error("AssemblyAI upload did not return upload_url");

  const submit = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: uploadBody.upload_url,
      speech_models: assemblySpeechModels(options.model),
      ...(options.language
        ? { language_code: options.language }
        : { language_detection: true }),
      speaker_labels: true,
    }),
  });

  if (!submit.ok) {
    throw new Error(
      `AssemblyAI transcript submit failed: ${submit.status} ${await submit.text()}`,
    );
  }

  const submitted = (await submit.json()) as { id?: string };
  if (!submitted.id)
    throw new Error("AssemblyAI transcript submit did not return id");

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    const poll = await fetch(
      `https://api.assemblyai.com/v2/transcript/${submitted.id}`,
      {
        headers: { authorization: apiKey },
      },
    );
    if (!poll.ok) {
      throw new Error(
        `AssemblyAI transcript poll failed: ${poll.status} ${await poll.text()}`,
      );
    }

    const body = (await poll.json()) as { status?: string; error?: string };
    if (body.status === "completed") return normalizeAssemblyAIResponse(body);
    if (body.status === "error") {
      if (isEmptyTranscriptError(body.error))
        return emptyAssemblyTranscript(submitted.id);
      throw new Error(body.error ?? "AssemblyAI transcription failed");
    }
  }

  throw new Error(
    `AssemblyAI transcription timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

async function saveTranscript(
  config: AppConfig,
  row: RecordingRow,
  segments: TranscriptSegment[],
): Promise<string> {
  const shard = row.sha256.slice(0, 2);
  const dir = join(config.transcriptsDir, shard);
  const path = join(dir, `${row.sha256}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(segments, null, 2)}\n`);
  return path;
}

function resolveProvider(
  config: AppConfig,
  options: TranscribeOptions,
): {
  provider: TranscriptionProvider;
  apiKey: string;
} {
  if (options.provider) {
    return {
      provider: options.provider,
      apiKey: apiKeyForProvider(config, options.provider, options),
    };
  }

  if (options.apiKey) return { provider: "assemblyai", apiKey: options.apiKey };

  const assemblyKey = apiKeyForProvider(config, "assemblyai", options, false);
  if (assemblyKey) return { provider: "assemblyai", apiKey: assemblyKey };

  const deepgramKey = apiKeyForProvider(config, "deepgram", options, false);
  if (deepgramKey) return { provider: "deepgram", apiKey: deepgramKey };

  throw new Error(
    `Missing ASSEMBLYAI_API_KEY. Store it with \`${secretPutCommand(options.secretScope ?? config.listenSecretScope)}\`, set ASSEMBLYAI_API_KEY, or pass --api-key.`,
  );
}

function apiKeyForProvider(
  config: AppConfig,
  provider: TranscriptionProvider,
  options: TranscribeOptions,
  required = true,
): string {
  const apiKey =
    options.apiKey ??
    envApiKey(provider) ??
    secretApiKey(config, provider, options, required);
  if (!apiKey) {
    const envName =
      provider === "deepgram" ? "DEEPGRAM_API_KEY" : "ASSEMBLYAI_API_KEY";
    if (!required) return "";
    throw new Error(`Missing ${envName} or --api-key`);
  }
  return apiKey;
}

function envApiKey(provider: TranscriptionProvider): string | undefined {
  return provider === "deepgram"
    ? process.env.DEEPGRAM_API_KEY
    : process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLY_API_KEY;
}

function secretApiKey(
  config: AppConfig,
  provider: TranscriptionProvider,
  options: TranscribeOptions,
  required: boolean,
): string | undefined {
  const name =
    provider === "deepgram" ? "DEEPGRAM_API_KEY" : "ASSEMBLYAI_API_KEY";
  try {
    return getSecret(name, {
      ...options.tcOptions,
      scope: options.secretScope ?? config.listenSecretScope,
    });
  } catch (err) {
    if (!required) return undefined;
    throw err;
  }
}

function secretPutCommand(scope: string): string {
  return [
    "tc",
    "secrets",
    "put",
    "ASSEMBLYAI_API_KEY",
    ...(scope ? ["--scope", scope] : []),
  ].join(" ");
}

function millisToSeconds(value: number | undefined): number | null {
  return typeof value === "number" ? value / 1000 : null;
}

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assemblySpeechModels(model: string | undefined): string[] {
  if (!model) return DEFAULT_ASSEMBLY_SPEECH_MODELS;
  const models = model
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return models.length > 0 ? models : DEFAULT_ASSEMBLY_SPEECH_MODELS;
}

function emptyAssemblyTranscript(providerJobId: string): NormalizedTranscript {
  return {
    provider: "assemblyai",
    providerJobId,
    text: "",
    segments: [],
    durationSecs: null,
  };
}

export function isEmptyTranscriptError(error: string | undefined): boolean {
  if (typeof error !== "string") return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes("no spoken audio") ||
    normalized.includes("does not appear to contain audio") ||
    normalized.includes("audio duration is too short")
  );
}

function maxEndTime(
  segments: Array<Pick<TranscriptSegment, "end_time">>,
): number | null {
  const values = segments
    .map((segment) => segment.end_time)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  return values.length > 0 ? Math.max(...values) : null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
