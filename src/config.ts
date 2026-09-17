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

const PreviewEnvironmentSchema = z.object({
  FLOW_PREVIEW_MODE: z.literal("true"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

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
    OPENAI_API_KEY: OptionalSecretSchema,
    ANTHROPIC_API_KEY: OptionalSecretSchema,
    CURSOR_API_KEY: OptionalSecretSchema,
    FLOW_AGENT: OptionalProviderSchema,
    FLOW_BUILDER: ProviderSchema.default("codex"),
    FLOW_REVIEWER: ProviderSchema.default("claude"),
    FLOW_CODEOWNERS: z.string().optional().default(""),
    FLOW_MAX_FIX_ROUNDS: z.coerce.number().int().min(0).max(5).default(2),
    FLOW_ADMIN_USERNAME: z.string().min(1).max(64).default("flow"),
    FLOW_ADMIN_PASSWORD: z.string().min(16),
    FLOW_CREDENTIAL_KEY: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be a 32-byte base64url value"),
  })
  .superRefine((value, context) => {
    const publicUrl = new URL(value.PUBLIC_URL);
    const developmentLocal = value.NODE_ENV === "development"
      && publicUrl.protocol === "http:"
      && ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
    if (value.NODE_ENV !== "test" && publicUrl.protocol !== "https:" && !developmentLocal) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_URL"],
        message: "PUBLIC_URL must use HTTPS, except localhost in development",
      });
    }
    if (value.NODE_ENV !== "test" && /(^|\.)example\.(?:com|net|org)$/i.test(publicUrl.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_URL"],
        message: "PUBLIC_URL is still a placeholder; use your Railway domain or HTTPS tunnel URL",
      });
    }
    if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || !["", "/"].includes(publicUrl.pathname)) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_URL"],
        message: "PUBLIC_URL must be a bare public origin without credentials, path, query, or fragment",
      });
    }
    const codeowners = value.FLOW_CODEOWNERS.split(/[\s,]+/).filter(Boolean);
    if (
      codeowners.some((entry) => !/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(entry))
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
  providers: { openaiApiKey?: string; anthropicApiKey?: string; cursorApiKey?: string };
  flow: {
    builder: Provider;
    reviewer: Provider;
    qa: Provider;
    codeowners: string[];
    maxFixRounds: number;
  };
  admin: { username: string; password: string };
  credentialKey: Buffer;
};

export type StartupConfig =
  | { mode: "preview"; port: number }
  | { mode: "production"; config: AppConfig };

export const loadConfig = (env: Record<string, string | undefined>): AppConfig => {
  const value = EnvironmentSchema.parse(env);
  const builder = value.FLOW_AGENT ?? value.FLOW_BUILDER;
  const reviewer = value.FLOW_AGENT ?? value.FLOW_REVIEWER;
  const cursor = value.CURSOR_API_KEY ? { cursorApiKey: value.CURSOR_API_KEY } : {};
  const anthropic = value.ANTHROPIC_API_KEY ? { anthropicApiKey: value.ANTHROPIC_API_KEY } : {};
  const openai = value.OPENAI_API_KEY ? { openaiApiKey: value.OPENAI_API_KEY } : {};

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
      ...openai,
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
    admin: {
      username: value.FLOW_ADMIN_USERNAME,
      password: value.FLOW_ADMIN_PASSWORD,
    },
    credentialKey: Buffer.from(value.FLOW_CREDENTIAL_KEY, "base64url"),
  };
};

export const loadStartupConfig = (env: Record<string, string | undefined>): StartupConfig => {
  if (env.FLOW_PREVIEW_MODE === "true") {
    const preview = PreviewEnvironmentSchema.parse(env);
    return { mode: "preview", port: preview.PORT };
  }
  return { mode: "production", config: loadConfig(env) };
};
