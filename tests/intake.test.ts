import { describe, expect, it } from "vitest";
import type { FeedbackBundle, WorkPlan } from "../src/domain.js";
import {
  WorkPlanSchema,
  buildWorkPlan,
  createAnthropicIntakeClient,
  formatIssueBody,
  prepareFeedback,
  redactSecrets,
} from "../src/intake.js";

const bundle = (text: string): FeedbackBundle => ({
  source: { chatId: "-100", topicId: "77", userId: "123", messageIds: [1] },
  repository: "acme/store",
  items: [{ kind: "text", text }],
});

const validPlan = (overrides: Partial<WorkPlan> = {}): WorkPlan => ({
  title: "Repair checkout",
  problem: "The checkout button does not submit the order.",
  evidence: ["Owner reproduced it on mobile."],
  acceptanceCriteria: ["Checkout submits exactly one order."],
  nonGoals: ["Redesigning checkout."],
  risks: [],
  needsHumanInput: false,
  units: [
    {
      title: "Repair checkout submission",
      body: "Implement and test the checkout submission fix.",
      canRunInParallel: true,
    },
  ],
  ...overrides,
});

describe("intake planning", () => {
  it("uses Anthropic's structured tool result for planning with image evidence", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = createAnthropicIntakeClient({
      apiKey: "anthropic-key",
      model: "claude-planner",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", name: "create_work_plan", input: validPlan() }],
        }), { status: 200 });
      },
    });

    await expect(client.createPlan({
      submissionId: "test:anthropic-1",
      feedback: "The save button does nothing.",
      repository: "acme/store",
      context: {},
      images: ["data:image/png;base64,c2NyZWVu"],
    })).resolves.toEqual(validPlan());
    expect(requestBody).toMatchObject({ model: "claude-planner", tool_choice: { name: "create_work_plan" } });
    expect(JSON.stringify(requestBody)).toContain('"type":"image"');
    expect(JSON.stringify(requestBody)).not.toContain("test:anthropic-1");
  });

  it("rejects more than four work units", () => {
    const units = Array.from({ length: 5 }, (_, index) => ({
      title: `Unit ${index + 1}`,
      body: "Independent change",
      canRunInParallel: true,
    }));

    expect(() => WorkPlanSchema.parse(validPlan({ units }))).toThrow();
  });

  it("collapses model-proposed units when any unit is dependent", async () => {
    const model = { createPlan: async () => validPlan({
      units: [
        { title: "Schema", body: "Change schema", canRunInParallel: false },
        { title: "API", body: "Use new schema", canRunInParallel: false },
      ],
    }) };

    const plan = await buildWorkPlan(bundle("Change schema then update API"), {}, model);

    expect(plan.units).toEqual([
      {
        title: "Repair checkout",
        body: "Change schema\n\nUse new schema",
        canRunInParallel: false,
      },
    ]);
  });

  it("forces human input for high-risk work", async () => {
    const model = { createPlan: async () => validPlan() };

    const plan = await buildWorkPlan(bundle("Change production billing authorization"), {}, model);

    expect(plan.needsHumanInput).toBe(true);
    expect(plan.risks).toContain("High-risk area detected in submitted feedback.");
    expect(plan.clarifications?.[0]?.question).toMatch(/confirm/i);
  });

  it("requires a concrete clarification when the planner needs human input", () => {
    expect(() => WorkPlanSchema.parse(validPlan({ needsHumanInput: true }))).toThrow(/clarification/i);
    expect(WorkPlanSchema.parse(validPlan({
      needsHumanInput: true,
      clarifications: [{ question: "Which account role should see the control?" }],
    })).clarifications).toHaveLength(1);
  });

  it("forces human input when visual analysis surfaces a high-risk area", async () => {
    const model = { createPlan: async () => validPlan({ problem: "The screenshot shows the production billing form failing." }) };

    const plan = await buildWorkPlan(bundle("Screenshot attached"), {}, model, {
      text: "Screenshot attached",
      images: ["data:image/png;base64,c2NyZWVu"],
    });

    expect(plan.needsHumanInput).toBe(true);
  });

  it("makes exactly one schema-repair attempt", async () => {
    let calls = 0;
    const model = {
      createPlan: async (_input: unknown, validationErrors?: string[]) => {
        calls += 1;
        return validationErrors ? validPlan() : { title: "missing fields" };
      },
    };

    const plan = await buildWorkPlan(bundle("Fix checkout"), {}, model);

    expect(plan.title).toBe("Repair checkout");
    expect(calls).toBe(2);
  });

  it("passes prepared image evidence to the planning model", async () => {
    let images: string[] | undefined;
    const model = {
      createPlan: async (input: { images?: string[] }) => {
        images = input.images;
        return validPlan();
      },
    };

    await buildWorkPlan(bundle("Screenshot attached"), {}, model, {
      text: "Screenshot attached",
      images: ["data:image/png;base64,c2NyZWVu"],
    });

    expect(images).toEqual(["data:image/png;base64,c2NyZWVu"]);
  });

  it("redacts credentials copied by the vision or planning model", async () => {
    const secret = "github_pat_abcdefghijklmnopqrstuv";
    const model = { createPlan: async () => validPlan({
      problem: `The screenshot displays ${secret} in the settings page.`,
      evidence: [`Visible token: ${secret}`],
    }) };

    const plan = await buildWorkPlan(bundle("Screenshot attached"), {}, model, {
      text: "Screenshot attached",
      images: ["data:image/png;base64,c2NyZWVu"],
    });

    expect(JSON.stringify(plan)).not.toContain("abcdefghijklmnopqrstuv");
    expect(JSON.stringify(plan)).toContain("REDACTED");
  });
});

describe("feedback preparation", () => {
  it("redacts common secret forms", () => {
    expect(redactSecrets("OPENAI_API_KEY=sk-secret password: hunter2 bearer abc.def.ghi"))
      .toBe("OPENAI_API_KEY=[REDACTED] password: [REDACTED] bearer [REDACTED]");
  });

  it("redacts provider tokens, GitHub PATs, JWTs, JSON secrets, and private keys", () => {
    const input = [
      "sk-ant-api03_abcdefghijklmnopqrstuv",
      "github_pat_abcdefghijklmnopqrstuv",
      "eyJabcdefgh.ijklmnopq.rstuvwxyz",
      '{"access_token":"top-secret-value"}',
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).not.toContain("abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("top-secret-value");
    expect(redacted).not.toContain("private-material");
  });

  it("rejects Telegram media over the Bot API download limit", async () => {
    const oversized: FeedbackBundle = {
      ...bundle("See attachment"),
      items: [{ kind: "document", fileId: "big", fileSize: 20 * 1024 * 1024 + 1 }],
    };

    await expect(prepareFeedback(oversized, {
      downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
      transcribe: async () => "",
      analyzeVideo: async () => ({ transcript: "", images: [] }),
    })).rejects.toThrow(/20 MB/);
  });

  it("transcribes voice and retains an image as a data URL", async () => {
    const mediaBundle: FeedbackBundle = {
      ...bundle("Details"),
      items: [
        { kind: "voice", fileId: "voice", mimeType: "audio/ogg" },
        { kind: "photo", fileId: "photo" },
      ],
    };

    const prepared = await prepareFeedback(mediaBundle, {
      downloadFile: async (fileId) => ({
        bytes: Buffer.from(fileId),
        mimeType: fileId === "voice" ? "audio/ogg" : "image/jpeg",
      }),
      transcribe: async () => "Checkout fails after I tap pay.",
      analyzeVideo: async () => ({ transcript: "", images: [] }),
    });

    expect(prepared.text).toContain("Checkout fails after I tap pay.");
    expect(prepared.images).toEqual(["data:image/jpeg;base64,cGhvdG8="]);
  });

  it("adds a recording transcript and sampled visual frames to the planning evidence", async () => {
    const recording: FeedbackBundle = {
      ...bundle("Recording"),
      items: [{ kind: "video", fileId: "recording", mimeType: "video/mp4" }],
    };

    const prepared = await prepareFeedback(recording, {
      downloadFile: async () => ({ bytes: Buffer.from("video"), mimeType: "video/mp4" }),
      transcribe: async () => "",
      analyzeVideo: async () => ({
        transcript: "I tap Save, but no row appears.",
        images: ["data:image/jpeg;base64,ZnJhbWU="],
      }),
    });

    expect(prepared.text).toContain("I tap Save, but no row appears.");
    expect(prepared.images).toEqual(["data:image/jpeg;base64,ZnJhbWU="]);
  });
});

describe("issue formatting", () => {
  it("renders stable sections and escapes user-authored HTML", () => {
    const body = formatIssueBody(
      validPlan({ problem: "Button shows <script>alert(1)</script>" }),
    );

    expect(body).toContain("## Problem");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("Recorded privately by Flow AI");
    expect(body).not.toContain("Telegram chat");
    expect(body).not.toContain("-100");
    expect(body).not.toContain("<script>");
  });
});
