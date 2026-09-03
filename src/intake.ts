import { z } from "zod";
import type { FeedbackBundle, WorkPlan } from "./domain.js";

const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;
const HIGH_RISK_PATTERN = /\b(auth(?:entication|orization)?|billing|payment|destructive|migration|production|infrastructure|legal|privacy)\b/i;

export const WorkPlanSchema = z
  .object({
    title: z.string().trim().min(3).max(160),
    problem: z.string().trim().min(10),
    evidence: z.array(z.string().trim().min(1)).max(20),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).max(20),
    nonGoals: z.array(z.string().trim().min(1)).max(20),
    risks: z.array(z.string().trim().min(1)).max(20),
    needsHumanInput: z.boolean(),
    units: z
      .array(
        z.object({
          title: z.string().trim().min(3).max(160),
          body: z.string().trim().min(5),
          canRunInParallel: z.boolean(),
        }).strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export type RepositoryContext = {
  readme?: string;
  rules?: string;
  config?: string;
  fileTree?: string[];
};

export type IntakeModel = {
  createPlan(input: PlanningInput, validationErrors?: string[]): Promise<unknown>;
};

export type PlanningInput = {
  feedback: string;
  repository: string;
  context: RepositoryContext;
  images?: string[];
};

export type MediaDependencies = {
  downloadFile(fileId: string): Promise<{ bytes: Buffer; mimeType: string }>;
  transcribe(bytes: Buffer, mimeType: string): Promise<string>;
};

export type PreparedFeedback = {
  text: string;
  images: string[];
};

export const redactSecrets = (input: string): string =>
  input
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/\b(password\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]");

const bundleText = (bundle: FeedbackBundle): string =>
  bundle.items
    .flatMap((item) => {
      if (item.kind === "text") return [item.text];
      const description = `${item.kind} attachment (${item.fileId})`;
      return item.caption ? [description, item.caption] : [description];
    })
    .map(redactSecrets)
    .join("\n\n");

const parsePlan = (input: unknown): WorkPlan => WorkPlanSchema.parse(input);

export const buildWorkPlan = async (
  bundle: FeedbackBundle,
  context: RepositoryContext,
  model: IntakeModel,
  prepared?: PreparedFeedback,
): Promise<WorkPlan> => {
  const planningInput: PlanningInput = {
    feedback: prepared?.text ?? bundleText(bundle),
    repository: bundle.repository,
    context,
    ...(prepared?.images.length ? { images: prepared.images } : {}),
  };

  let plan: WorkPlan;
  try {
    plan = parsePlan(await model.createPlan(planningInput));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid work plan";
    plan = parsePlan(await model.createPlan(planningInput, [message]));
  }

  if (plan.units.length > 1 && plan.units.some((unit) => !unit.canRunInParallel)) {
    plan = {
      ...plan,
      units: [
        {
          title: plan.title,
          body: plan.units.map((unit) => unit.body).join("\n\n"),
          canRunInParallel: false,
        },
      ],
    };
  }

  if (HIGH_RISK_PATTERN.test(planningInput.feedback)) {
    const risk = "High-risk area detected in submitted feedback.";
    plan = {
      ...plan,
      needsHumanInput: true,
      risks: plan.risks.includes(risk) ? plan.risks : [...plan.risks, risk],
    };
  }

  return plan;
};

export const prepareFeedback = async (
  bundle: FeedbackBundle,
  dependencies: MediaDependencies,
): Promise<PreparedFeedback> => {
  const text: string[] = [];
  const images: string[] = [];

  for (const item of bundle.items) {
    if (item.kind === "text") {
      text.push(redactSecrets(item.text));
      continue;
    }
    if (item.fileSize !== undefined && item.fileSize > TELEGRAM_FILE_LIMIT) {
      throw new Error("Telegram Bot API attachments must be 20 MB or smaller");
    }
    const file = await dependencies.downloadFile(item.fileId);
    if (file.bytes.byteLength > TELEGRAM_FILE_LIMIT) {
      throw new Error("Telegram Bot API attachments must be 20 MB or smaller");
    }
    if (item.caption) text.push(redactSecrets(item.caption));
    if (item.kind === "voice") {
      text.push(redactSecrets(await dependencies.transcribe(file.bytes, file.mimeType)));
    } else if (item.kind === "photo") {
      images.push(`data:${file.mimeType};base64,${file.bytes.toString("base64")}`);
    } else {
      text.push(`Document attached: ${item.fileId}`);
    }
  }

  return { text: text.join("\n\n"), images };
};

const escapeHtml = (input: string): string =>
  input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const bullets = (items: string[]): string =>
  items.length === 0 ? "- None" : items.map((item) => `- ${escapeHtml(item)}`).join("\n");

export const formatIssueBody = (plan: WorkPlan, source: FeedbackBundle["source"]): string => `## Problem

${escapeHtml(plan.problem)}

## Evidence

${bullets(plan.evidence)}

## Acceptance criteria

${plan.acceptanceCriteria.map((criterion) => `- [ ] ${escapeHtml(criterion)}`).join("\n")}

## Non-goals

${bullets(plan.nonGoals)}

## Risks

${bullets(plan.risks)}

## Source

- Telegram chat: ${escapeHtml(source.chatId)}
- Telegram topic: ${source.topicId === null ? "none" : escapeHtml(source.topicId)}
- Telegram user: ${escapeHtml(source.userId)}
- Telegram messages: ${source.messageIds.join(", ")}
`;

type OpenAIIntakeOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  planningModel?: string;
  transcriptionModel?: string;
};

const workPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "problem",
    "evidence",
    "acceptanceCriteria",
    "nonGoals",
    "risks",
    "needsHumanInput",
    "units",
  ],
  properties: {
    title: { type: "string" },
    problem: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
    nonGoals: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    needsHumanInput: { type: "boolean" },
    units: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "canRunInParallel"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          canRunInParallel: { type: "boolean" },
        },
      },
    },
  },
} as const;

const extractResponseText = (input: unknown): string => {
  const response = z
    .object({
      output_text: z.string().optional(),
      output: z
        .array(
          z.object({
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
          }),
        )
        .optional(),
    })
    .parse(input);
  if (response.output_text) return response.output_text;
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("OpenAI response did not contain output text");
};

export const createOpenAIIntakeClient = (options: OpenAIIntakeOptions): IntakeModel & {
  transcribe(bytes: Buffer, mimeType: string): Promise<string>;
} => {
  const request = options.fetch ?? fetch;
  const planningModel = options.planningModel ?? "gpt-5.4-mini";
  const transcriptionModel = options.transcriptionModel ?? "gpt-4o-mini-transcribe";
  const authorize = { Authorization: `Bearer ${options.apiKey}` };

  return {
    async createPlan(input, validationErrors) {
      const repair = validationErrors?.length
        ? `\nThe previous response failed validation:\n${validationErrors.join("\n")}`
        : "";
      const imageParts = (input.images ?? []).map((imageUrl) => ({ type: "input_image", image_url: imageUrl }));
      const response = await request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { ...authorize, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: planningModel,
          input: [
            {
              role: "system",
              content: [{
                type: "input_text",
                text: "Convert feedback into an implementation-ready plan. Do not invent facts. Create 1-4 units only when they are independently mergeable; otherwise create one unit.",
              }],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    repository: input.repository,
                    feedback: input.feedback,
                    context: input.context,
                    repair,
                  }),
                },
                ...imageParts,
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "work_plan",
              strict: true,
              schema: workPlanJsonSchema,
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`OpenAI planning request failed with ${response.status}`);
      return JSON.parse(extractResponseText(await response.json())) as unknown;
    },

    async transcribe(bytes, mimeType) {
      const form = new FormData();
      form.set("model", transcriptionModel);
      form.set("file", new Blob([Uint8Array.from(bytes)], { type: mimeType }), "feedback.ogg");
      const response = await request("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: authorize,
        body: form,
      });
      if (!response.ok) throw new Error(`OpenAI transcription failed with ${response.status}`);
      return z.object({ text: z.string() }).parse(await response.json()).text;
    },
  };
};
