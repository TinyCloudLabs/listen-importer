export type ListenSource =
  | "recorder"
  | "voice_memos"
  | "voxterm"
  | "soundcore_sync";

export function parseListenSource(
  value: string | undefined,
): ListenSource | undefined {
  if (!value || value === "all") return undefined;
  if (value === "recorder" || value === "voxterm") return value;
  if (value === "voice_memos" || value === "voice-memos") return "voice_memos";
  if (value === "soundcore_sync" || value === "soundcore-sync")
    return "soundcore_sync";
  throw new Error(
    "--source must be recorder, voice_memos, voice-memos, voxterm, soundcore_sync, soundcore-sync, or all",
  );
}
