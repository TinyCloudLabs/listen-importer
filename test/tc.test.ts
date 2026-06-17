import { describe, expect, test } from "vitest";
import { parseSecretsDoctorStatus } from "../src/tc";

describe("TinyCloud CLI helpers", () => {
  test("parses secrets doctor JSON", () => {
    const status = parseSecretsDoctorStatus(
      JSON.stringify({
        healthy: true,
        network: {
          name: "default",
          networkId: "urn:tinycloud:encryption:did:key:z6Mk:default",
          exists: true,
          state: "active",
        },
        secret: {
          name: "ASSEMBLYAI_API_KEY",
          path: "vault/secrets/ASSEMBLYAI_API_KEY",
          exists: true,
          readable: true,
        },
        checks: [
          {
            name: "Secret access",
            ok: true,
            detail: "vault/secrets/ASSEMBLYAI_API_KEY readable",
          },
        ],
      }),
    );

    expect(status).toEqual({
      healthy: true,
      network: {
        networkId: "urn:tinycloud:encryption:did:key:z6Mk:default",
        exists: true,
        state: "active",
        name: "default",
      },
      secret: {
        name: "ASSEMBLYAI_API_KEY",
        path: "vault/secrets/ASSEMBLYAI_API_KEY",
        scope: null,
        exists: true,
        readable: true,
      },
      checks: [
        {
          name: "Secret access",
          ok: true,
          detail: "vault/secrets/ASSEMBLYAI_API_KEY readable",
          hint: null,
        },
      ],
    });
  });
});
