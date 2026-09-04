import { describe, expect, it } from "vitest";
import { createOpenAIIntakeClient } from "../src/intake.js";
import { registerTelegramWebhook } from "../src/index.js";
import { createTelegramClient } from "../src/telegram.js";
import { loadConfig } from "../src/config.js";
import { validEnv } from "./helpers.js";

const samplePlan = {
  title: "Repair checkout",
  problem: "Checkout does not submit an order.",
  evidence: [],
  acceptanceCriteria: ["Checkout submits one order."],
  nonGoals: [],
  risks: [],
  needsHumanInput: false,
  units: [{ title: "Repair checkout", body: "Fix and test checkout.", canRunInParallel: true }],
};

describe("OpenAI intake client", () => {
  it("requests a JSON work plan through the Responses API", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(samplePlan) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createOpenAIIntakeClient({ apiKey: "secret-key", fetch: fakeFetch });

    const result = await client.createPlan({
      submissionId: "test:openai-1",
      feedback: "Fix checkout",
      repository: "acme/store",
      context: { fileTree: ["src/checkout.ts"] },
    });

    expect(result).toEqual(samplePlan);
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer secret-key");
    const body = JSON.parse(String(capturedInit?.body)) as { model: string; input: unknown[] };
    expect(body.model).toBe("gpt-5.4-mini");
    expect(JSON.stringify(body.input)).toContain("Fix checkout");
  });

  it("transcribes an audio buffer with the Audio API", async () => {
    let capturedBody: RequestInit["body"];
    const fakeFetch: typeof fetch = async (_input, init) => {
      capturedBody = init?.body;
      return new Response(JSON.stringify({ text: "Spoken feedback" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createOpenAIIntakeClient({ apiKey: "secret-key", fetch: fakeFetch });

    const result = await client.transcribe(Buffer.from("voice"), "audio/ogg");

    expect(result).toBe("Spoken feedback");
    expect(capturedBody).toBeInstanceOf(FormData);
    expect((capturedBody as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
  });
});

describe("Telegram API client", () => {
  it("resolves a file and downloads its bytes", async () => {
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/getFile")) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file.ogg", file_size: 5 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from("voice"), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    };
    const client = createTelegramClient({ token: "123:token", fetch: fakeFetch });

    const file = await client.downloadFile("voice-id");

    expect(file).toEqual({ bytes: Buffer.from("voice"), mimeType: "audio/ogg" });
    expect(requests).toHaveLength(2);
  });

  it("reports Telegram's sanitized API reason without exposing the bot token", async () => {
    const token = "123456:super-secret-token";
    const client = createTelegramClient({
      token,
      fetch: async () => new Response(JSON.stringify({
        ok: false,
        description: `Bad Request: bad webhook URL for ${token}`,
      }), { status: 400, headers: { "content-type": "application/json" } }),
    });

    await expect(client.setWebhook("https://invalid.example", "secret"))
      .rejects.toThrow("Telegram setWebhook failed with 400: Bad Request: bad webhook URL for [REDACTED]");
    await expect(client.setWebhook("https://invalid.example", "secret"))
      .rejects.not.toThrow(token);
  });
});

describe("Telegram startup", () => {
  it("keeps local Admin running when development webhook registration fails", async () => {
    const warnings: string[] = [];
    const config = loadConfig(validEnv({ NODE_ENV: "development", PUBLIC_URL: "http://localhost:3000" }));

    await expect(registerTelegramWebhook({
      setWebhook: async () => { throw new Error("Telegram setWebhook failed with 400: HTTPS URL required"); },
    }, config, (message) => warnings.push(message))).resolves.toBeUndefined();

    expect(warnings.join("\n")).toContain("Admin remains available");
  });

  it("keeps webhook registration strict in production", async () => {
    const config = loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_URL: "https://flow.example.test",
    }));

    await expect(registerTelegramWebhook({
      setWebhook: async () => { throw new Error("Telegram setWebhook failed with 400"); },
    }, config, () => undefined)).rejects.toThrow("Telegram setWebhook failed with 400");
  });
});
