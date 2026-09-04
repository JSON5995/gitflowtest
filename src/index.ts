import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { createGitHubAppAccess } from "./github-app.js";
import { createGitHubGateway, registerGitHubRoutes } from "./github.js";
import { createOpenAIIntakeClient } from "./intake.js";
import { processTelegramUpdate } from "./orchestrator.js";
import { buildServer } from "./server.js";
import { openStorage } from "./storage.js";
import { createTelegramClient, registerTelegramRoutes, type ParsedTelegramUpdate } from "./telegram.js";
import { startWorker } from "./worker.js";
import { createVideoAnalyzer } from "./video.js";

export type RunningApplication = {
  address: string;
  close(): Promise<void>;
};

export const startApplication = async (config: AppConfig): Promise<RunningApplication> => {
  const storage = openStorage(config.databasePath);
  const telegram = createTelegramClient({ token: config.telegram.botToken });
  const intake = createOpenAIIntakeClient({ apiKey: config.providers.openaiApiKey });
  const analyzeVideo = createVideoAnalyzer({ transcribe: intake.transcribe });
  const appAccess = createGitHubAppAccess({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const github = createGitHubGateway({
    webhookSecret: config.github.webhookSecret,
    getInstallationId: appAccess.getInstallationId,
    getApi: appAccess.getApi,
  });
  const botLogin = `${await appAccess.getAppSlug()}[bot]`;
  const server = buildServer({
    isReady: storage.isReady,
    admin: {
      username: config.admin.username,
      password: config.admin.password,
      getSummary: storage.getAdminSummary,
    },
  });
  registerTelegramRoutes(server, {
    storage,
    webhookSecret: config.telegram.webhookSecret,
    allowedUserIds: config.telegram.adminIds,
  });
  await registerGitHubRoutes(server, {
    storage,
    webhookSecret: config.github.webhookSecret,
  });

  const worker = startWorker({
    storage,
    github,
    botLogin,
    maxFixRounds: config.flow.maxFixRounds,
    processTelegram: async (input) => processTelegramUpdate(input as ParsedTelegramUpdate, {
      storage,
      adminIds: config.telegram.adminIds,
      telegram,
      transcribe: intake.transcribe,
      analyzeVideo,
      model: intake,
      github,
      builder: config.flow.builder,
    }),
    onError: (error) => console.error("Worker error:", error.message),
  }, telegram);

  try {
    const address = await server.listen({ host: "0.0.0.0", port: config.port });
    await telegram.setWebhook(
      `${config.publicUrl}/webhooks/telegram`,
      config.telegram.webhookSecret,
    );
    return {
      address,
      async close() {
        await worker.stop();
        await server.close();
        storage.close();
      },
    };
  } catch (error) {
    await worker.stop();
    await server.close();
    storage.close();
    throw error;
  }
};

export const main = async (): Promise<void> => {
  const application = await startApplication(loadConfig(process.env));
  console.info(`Flow AI listening at ${application.address}`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await application.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
