export type ListenSource = "recorder" | "voice_memos" | "voxterm";

export function parseListenSource(
  value: string | undefined,
): ListenSource | undefined {
  if (!value || value === "all") return undefined;
  if (value === "recorder" || value === "voxterm") return value;
  if (value === "voice_memos" || value === "voice-memos") return "voice_memos";
  throw new Error(
    "--source must be recorder, voice_memos, voice-memos, voxterm, or all",
  );
}
