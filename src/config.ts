import { z } from "zod";
import type { Provider } from "./domain.js";

const ProviderSchema = z.enum(["codex", "claude", "cursor"]);
const OptionalProviderSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  ProviderSchema.optional(),
);
const OptionalSecretSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    PUBLIC_URL: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_PATH: z.string().min(1).default("/data/flow.db"),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
    TELEGRAM_ADMIN_IDS: z.string().min(1),
    GITHUB_APP_ID: z.coerce.number().int().positive(),
    GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    OPENAI_API_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: OptionalSecretSchema,
    CURSOR_API_KEY: OptionalSecretSchema,
    FLOW_AGENT: OptionalProviderSchema,
    FLOW_BUILDER: ProviderSchema.default("codex"),
    FLOW_REVIEWER: ProviderSchema.default("claude"),
    FLOW_CODEOWNERS: z.string().min(1),
    FLOW_MAX_FIX_ROUNDS: z.coerce.number().int().min(0).max(5).default(2),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "test" && !value.PUBLIC_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "PUBLIC_URL must use HTTPS" });
    }
    const builder = value.FLOW_AGENT ?? value.FLOW_BUILDER;
    const reviewer = value.FLOW_AGENT ?? value.FLOW_REVIEWER;
    if (!value.FLOW_AGENT && builder === reviewer) {
      context.addIssue({
        code: "custom",
        path: ["FLOW_REVIEWER"],
        message: "Builder and reviewer providers must differ",
      });
    }
    if (
      (builder === "cursor" || reviewer === "cursor") &&
      !value.CURSOR_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["CURSOR_API_KEY"],
        message: "CURSOR_API_KEY is required when Cursor is selected",
      });
    }
    if ((builder === "claude" || reviewer === "claude") && !value.ANTHROPIC_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when Claude is selected",
      });
    }
    const codeowners = value.FLOW_CODEOWNERS.split(/[\s,]+/).filter(Boolean);
    if (
      codeowners.length === 0
      || codeowners.some((entry) => !/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(entry))
    ) {
      context.addIssue({
        code: "custom",
        path: ["FLOW_CODEOWNERS"],
        message: "FLOW_CODEOWNERS must contain GitHub @users or @org/teams",
      });
    }
  });

export type AppConfig = {
  environment: "development" | "test" | "production";
  publicUrl: string;
  port: number;
  databasePath: string;
  telegram: { botToken: string; webhookSecret: string; adminIds: string[] };
  github: { appId: number; privateKey: string; webhookSecret: string };
  providers: { openaiApiKey: string; anthropicApiKey?: string; cursorApiKey?: string };
  flow: {
    builder: Provider;
    reviewer: Provider;
    qa: Provider;
    codeowners: string[];
    maxFixRounds: number;
  };
};

export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
  const value = EnvironmentSchema.parse(env);
  const builder = value.FLOW_AGENT ?? value.FLOW_BUILDER;
  const reviewer = value.FLOW_AGENT ?? value.FLOW_REVIEWER;
  const cursor = value.CURSOR_API_KEY ? { cursorApiKey: value.CURSOR_API_KEY } : {};
  const anthropic = value.ANTHROPIC_API_KEY ? { anthropicApiKey: value.ANTHROPIC_API_KEY } : {};

  return {
    environment: value.NODE_ENV,
    publicUrl: value.PUBLIC_URL.replace(/\/$/, ""),
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    telegram: {
      botToken: value.TELEGRAM_BOT_TOKEN,
      webhookSecret: value.TELEGRAM_WEBHOOK_SECRET,
      adminIds: value.TELEGRAM_ADMIN_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    },
    github: {
      appId: value.GITHUB_APP_ID,
      privateKey: Buffer.from(value.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8"),
      webhookSecret: value.GITHUB_WEBHOOK_SECRET,
    },
    providers: {
      openaiApiKey: value.OPENAI_API_KEY,
      ...anthropic,
      ...cursor,
    },
    flow: {
      builder,
      reviewer,
      qa: value.FLOW_AGENT ?? reviewer,
      codeowners: value.FLOW_CODEOWNERS.split(/[\s,]+/).filter(Boolean),
      maxFixRounds: value.FLOW_MAX_FIX_ROUNDS,
    },
  };
};
