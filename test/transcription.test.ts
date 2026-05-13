import { describe, expect, test } from "bun:test";
import {
  normalizeAssemblyAIResponse,
  normalizeDeepgramResponse,
} from "../src/transcription";

describe("transcription normalization", () => {
  test("maps Deepgram utterances into Listen transcript segments", () => {
    const transcript = normalizeDeepgramResponse({
      metadata: { request_id: "dg-1" },
      results: {
        utterances: [
          { speaker: 0, transcript: "Hello there", start: 0.1, end: 1.2 },
          { speaker: 1, transcript: "Hi", start: 1.4, end: 2.1 },
        ],
      },
    });

    expect(transcript.provider).toBe("deepgram");
    expect(transcript.providerJobId).toBe("dg-1");
    expect(transcript.durationSecs).toBe(2.1);
    expect(transcript.segments).toEqual([
      {
        speaker_name: "Speaker 1",
        text: "Hello there",
        start_time: 0.1,
        end_time: 1.2,
        language: null,
      },
      {
        speaker_name: "Speaker 2",
        text: "Hi",
        start_time: 1.4,
        end_time: 2.1,
        language: null,
      },
    ]);
  });

  test("maps AssemblyAI utterances from milliseconds into seconds", () => {
    const transcript = normalizeAssemblyAIResponse({
      id: "aa-1",
      utterances: [
        { speaker: "A", text: "First", start: 100, end: 1200 },
        { speaker: "B", text: "Second", start: 1300, end: 2500 },
      ],
    });

    expect(transcript.provider).toBe("assemblyai");
    expect(transcript.providerJobId).toBe("aa-1");
    expect(transcript.durationSecs).toBe(2.5);
    expect(transcript.segments).toEqual([
      {
        speaker_name: "Speaker A",
        text: "First",
        start_time: 0.1,
        end_time: 1.2,
      },
      {
        speaker_name: "Speaker B",
        text: "Second",
        start_time: 1.3,
        end_time: 2.5,
      },
    ]);
  });
});
