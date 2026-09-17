import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadStartupConfig, type AppConfig } from "./config.js";
import {
  createControlPlane,
  createProviderModelDiscovery,
  createRepositoryCredentialSync,
  createRepositoryProvisioner,
  type ControlPlane,
} from "./control-plane.js";
import { createCredentialVault } from "./credential-vault.js";
import { createGitHubAppAccess } from "./github-app.js";
import { createGitHubGateway, registerGitHubRoutes } from "./github.js";
import { createOpenAIIntakeClient } from "./intake.js";
import { createRoutingService } from "./routing-service.js";
import { createRoutedIntakeModel } from "./routed-intake.js";
import { processTelegramUpdate } from "./orchestrator.js";
import { loadRepositoryKit } from "./provision.js";
import { buildPreviewServer } from "./preview.js";
import { buildServer } from "./server.js";
import { openStorage } from "./storage.js";
import { createTelegramClient, registerTelegramRoutes, type ParsedTelegramUpdate } from "./telegram.js";
import { startWorker } from "./worker.js";
import { createVideoAnalyzer } from "./video.js";

export type RunningApplication = {
  address: string;
  close(): Promise<void>;
};

export const registerTelegramWebhook = async (
  telegram: Pick<ReturnType<typeof createTelegramClient>, "setWebhook">,
  config: AppConfig,
  warn: (message: string) => void = console.warn,
): Promise<void> => {
  try {
    await telegram.setWebhook(
      `${config.publicUrl}/webhooks/telegram`,
      config.telegram.webhookSecret,
    );
  } catch (error) {
    if (config.environment !== "development") throw error;
    const message = error instanceof Error ? error.message : "Telegram webhook registration failed";
    warn(`${message}. Admin remains available; start an HTTPS tunnel, update PUBLIC_URL, and restart Flow to receive Telegram updates.`);
  }
};

export const startApplication = async (config: AppConfig): Promise<RunningApplication> => {
  const storage = openStorage(config.databasePath);
  const telegram = createTelegramClient({ token: config.telegram.botToken });
  const appAccess = createGitHubAppAccess({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const controlPlaneHolder: { current?: ControlPlane } = {};
  const provisionFromAdmin = createRepositoryProvisioner({
    storage,
    appAccess,
    getCredential: (provider) => controlPlaneHolder.current?.getProviderCredentialValue(provider) ?? null,
    loadFiles: () => loadRepositoryKit(fileURLToPath(new URL("../repo-kit", import.meta.url))),
    checkIntegrationId: config.github.appId,
  });
  const controlPlane = createControlPlane({
    storage,
    vault: createCredentialVault(config.credentialKey),
    discoverModels: createProviderModelDiscovery(),
    provisionRepository: provisionFromAdmin,
    syncProviderCredential: createRepositoryCredentialSync({ storage, appAccess }),
  });
  controlPlaneHolder.current = controlPlane;
  if (config.providers.openaiApiKey) {
    controlPlane.seedProviderCredential("codex", config.providers.openaiApiKey);
  }
  if (config.providers.anthropicApiKey) {
    controlPlane.seedProviderCredential("claude", config.providers.anthropicApiKey);
  }
  if (config.providers.cursorApiKey) {
    controlPlane.seedProviderCredential("cursor", config.providers.cursorApiKey);
  }
  await Promise.allSettled((["codex", "claude"] as const)
    .filter((provider) => controlPlane.getProviderCredentialValue(provider) !== null)
    .map((provider) => controlPlane.refreshProviderModels(provider)));
  const routing = createRoutingService({ storage });
  const openAIIntake = () => {
    const apiKey = controlPlane.getProviderCredentialValue("codex");
    if (!apiKey) throw new Error("Connect an OpenAI API key in Flow Admin before submitting Telegram feedback");
    return createOpenAIIntakeClient({ apiKey });
  };
  const intake = {
    ...createRoutedIntakeModel({
      routing,
      getCredential: (provider) => controlPlane.getProviderCredentialValue(provider),
    }),
    transcribe: (...arguments_: Parameters<ReturnType<typeof createOpenAIIntakeClient>["transcribe"]>) =>
      openAIIntake().transcribe(...arguments_),
  };
  const analyzeVideo = createVideoAnalyzer({ transcribe: intake.transcribe });
  const appSlug = await appAccess.getAppSlug();
  const botLogin = `${appSlug}[bot]`;
  const github = createGitHubGateway({
    webhookSecret: config.github.webhookSecret,
    botLogin,
    getInstallationId: appAccess.getInstallationId,
    getApi: appAccess.getApi,
  });
  const server = buildServer({
    isReady: storage.isReady,
    admin: {
      username: config.admin.username,
      password: config.admin.password,
      publicUrl: config.publicUrl,
      trustedOrigins: config.environment === "development"
        ? [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]
        : [],
      getSummary: storage.getAdminSummary,
      controlPlane,
      github: {
        appSlug,
        stateSecret: config.credentialKey,
        access: appAccess,
      },
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
    routing,
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
    await registerTelegramWebhook(telegram, config);
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

export const startPreviewApplication = async (port: number): Promise<RunningApplication> => {
  const server = buildPreviewServer();
  try {
    const address = await server.listen({ host: "0.0.0.0", port });
    console.info("Flow preview mode active; storage, Admin, Telegram, GitHub, providers, credentials, workers, and webhooks are disabled.");
    return {
      address,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
};

export const main = async (): Promise<void> => {
  const startup = loadStartupConfig(process.env);
  const application = startup.mode === "preview"
    ? await startPreviewApplication(startup.port)
    : await startApplication(startup.config);
  console.info(`Flow listening at ${application.address}`);
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
