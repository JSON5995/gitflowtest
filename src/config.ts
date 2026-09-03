import { z } from "zod";
import type { Provider } from "./domain.js";

const ProviderSchema = z.enum(["codex", "claude", "cursor"]);

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
    ANTHROPIC_API_KEY: z.string().min(1),
    CURSOR_API_KEY: z.string().min(1).optional(),
    FLOW_BUILDER: ProviderSchema.default("codex"),
    FLOW_REVIEWER: ProviderSchema.default("claude"),
    FLOW_MAX_ISSUE_COST_USD: z.coerce.number().positive().default(25),
    FLOW_MAX_FIX_ROUNDS: z.coerce.number().int().min(0).max(5).default(2),
    FLOW_MAX_GLOBAL_BUILDS: z.coerce.number().int().min(1).max(50).default(5),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "test" && !value.PUBLIC_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "PUBLIC_URL must use HTTPS" });
    }
    if (value.FLOW_BUILDER === value.FLOW_REVIEWER) {
      context.addIssue({
        code: "custom",
        path: ["FLOW_REVIEWER"],
        message: "Builder and reviewer providers must differ",
      });
    }
    if (
      (value.FLOW_BUILDER === "cursor" || value.FLOW_REVIEWER === "cursor") &&
      !value.CURSOR_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["CURSOR_API_KEY"],
        message: "CURSOR_API_KEY is required when Cursor is selected",
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
  providers: { openaiApiKey: string; anthropicApiKey: string; cursorApiKey?: string };
  flow: {
    builder: Provider;
    reviewer: Provider;
    maxIssueCostUsd: number;
    maxFixRounds: number;
    maxGlobalBuilds: number;
  };
};

export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
  const value = EnvironmentSchema.parse(env);
  const cursor = value.CURSOR_API_KEY ? { cursorApiKey: value.CURSOR_API_KEY } : {};

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
      anthropicApiKey: value.ANTHROPIC_API_KEY,
      ...cursor,
    },
    flow: {
      builder: value.FLOW_BUILDER,
      reviewer: value.FLOW_REVIEWER,
      maxIssueCostUsd: value.FLOW_MAX_ISSUE_COST_USD,
      maxFixRounds: value.FLOW_MAX_FIX_ROUNDS,
      maxGlobalBuilds: value.FLOW_MAX_GLOBAL_BUILDS,
    },
  };
};
