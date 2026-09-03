import { describe, expect, it } from "vitest";
import type { FeedbackBundle, WorkPlan } from "../src/domain.js";
import {
  WorkPlanSchema,
  buildWorkPlan,
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
});

describe("feedback preparation", () => {
  it("redacts common secret forms", () => {
    expect(redactSecrets("OPENAI_API_KEY=sk-secret password: hunter2 bearer abc.def.ghi"))
      .toBe("OPENAI_API_KEY=[REDACTED] password: [REDACTED] bearer [REDACTED]");
  });

  it("rejects Telegram media over the Bot API download limit", async () => {
    const oversized: FeedbackBundle = {
      ...bundle("See attachment"),
      items: [{ kind: "document", fileId: "big", fileSize: 20 * 1024 * 1024 + 1 }],
    };

    await expect(prepareFeedback(oversized, {
      downloadFile: async () => ({ bytes: Buffer.alloc(0), mimeType: "application/octet-stream" }),
      transcribe: async () => "",
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
    });

    expect(prepared.text).toContain("Checkout fails after I tap pay.");
    expect(prepared.images).toEqual(["data:image/jpeg;base64,cGhvdG8="]);
  });
});

describe("issue formatting", () => {
  it("renders stable sections and escapes user-authored HTML", () => {
    const body = formatIssueBody(
      validPlan({ problem: "Button shows <script>alert(1)</script>" }),
      { chatId: "-100", topicId: "77", userId: "123", messageIds: [1, 2] },
    );

    expect(body).toContain("## Problem");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("Telegram messages: 1, 2");
    expect(body).not.toContain("<script>");
  });
});
