import { z } from "zod";
import type { CredentialVault } from "./credential-vault.js";
import { type Provider } from "./domain.js";
import type { GitHubAppAccess } from "./github-app.js";
import {
  provisionRepository,
  setRepositoryActionsSecret,
  verifyInstalledRepositoryKit,
  type ProvisionOptions,
  type ProvisionResult,
} from "./provision.js";
import type {
  ManagedRepository,
  ProviderModelCatalog,
  ProviderModelOption,
  RoutingSettings,
  RoutingSummary,
  Storage,
} from "./storage.js";

const providers: Provider[] = ["codex", "claude", "cursor"];

export type ProviderCredentialVerifier = (
  provider: Provider,
  credential: string,
) => Promise<void>;

export type ProviderModelDiscovery = (
  provider: Exclude<Provider, "cursor">,
  credential: string,
) => Promise<ProviderModelOption[]>;

export type ProviderConnection = {
  provider: Provider;
  configured: boolean;
  verification: "missing" | "configured" | "verified";
  verifiedAt: string | null;
};

export type ControlPlaneSnapshot = {
  providers: ProviderConnection[];
  modelCatalogs: ProviderModelCatalog[];
  routing: RoutingSettings | null;
  routingSummary: RoutingSummary;
  repositories: ManagedRepository[];
};

export type ProvisionRepositoryInput = {
  repository: string;
  codeowners: string[];
};

export type ProvisionRepositoryOutput = {
  repository: string;
  setupPullRequestUrl: string | null;
  mergeGateInstalled: boolean;
  status: ManagedRepository["status"];
};

export type ControlPlane = {
  getSnapshot(): ControlPlaneSnapshot;
  getProviderCredentialValue(provider: Provider): string | null;
  saveProviderCredential(provider: Provider, credential: string, now?: Date): Promise<void>;
  seedProviderCredential(provider: Provider, credential: string, now?: Date): void;
  refreshProviderModels(provider: Provider, now?: Date): Promise<void>;
  saveRoutingSettings(settings: RoutingSettings): void;
  provisionRepository(input: ProvisionRepositoryInput): Promise<ProvisionRepositoryOutput>;
};

type ControlPlaneStorage = Pick<
  Storage,
  | "getProviderCredential"
  | "setProviderCredential"
  | "getProviderModelCatalog"
  | "setProviderModelCatalog"
  | "getRoutingSettings"
  | "setRoutingSettings"
  | "getRoutingSummary"
  | "listManagedRepositories"
>;

const CandidateSchema = z.object({
  id: z.string().min(1).max(100),
  provider: z.enum(["codex", "claude", "cursor"]),
  model: z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/),
  tier: z.enum(["economy", "frontier"]),
  enabled: z.boolean(),
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative(),
  roles: z.array(z.enum(["intake", "plan", "build", "review", "qa", "security"])).min(1).max(6).optional(),
}).transform(({ roles, ...candidate }) => roles ? { ...candidate, roles } : candidate);

const RoutingSettingsSchema = z.object({
  candidates: z.array(CandidateSchema).min(1).max(20),
  policy: z.object({
    maxTransientRetriesPerCandidate: z.number().int().min(0).max(5),
    baseBackoffMs: z.number().int().min(0).max(600_000),
    maxBackoffMs: z.number().int().min(0).max(600_000),
    jitterRatio: z.number().min(0).max(1),
    reservationTtlMs: z.number().int().min(60_000).max(86_400_000),
    limits: z.object({
      perJobTokens: z.number().int().positive(),
      perJobCostMicros: z.number().int().positive(),
      monthlyTokens: z.number().int().positive(),
      monthlyCostMicros: z.number().int().positive(),
    }),
  }),
}).superRefine((settings, context) => {
  const ids = settings.candidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate IDs must be unique" });
  }
});

const credentialSchema = z.string().trim().min(8).max(16_384);

export const createProviderCredentialVerifier = (
  fetcher: typeof fetch = fetch,
): ProviderCredentialVerifier => async (provider, credential) => {
  if (provider === "cursor") return;
  const target = provider === "codex"
    ? "https://api.openai.com/v1/models"
    : "https://api.anthropic.com/v1/models?limit=1";
  const headers = provider === "codex"
    ? { Authorization: `Bearer ${credential}` }
    : { "x-api-key": credential, "anthropic-version": "2023-06-01" };
  let response: Response;
  try {
    response = await fetcher(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`${provider === "codex" ? "OpenAI" : "Anthropic"} credential verification is temporarily unavailable`);
  }
  if (!response.ok) {
    throw new Error(`${provider === "codex" ? "OpenAI" : "Anthropic"} rejected this credential (${response.status})`);
  }
};

const providerLabel = (provider: Exclude<Provider, "cursor">): string =>
  provider === "codex" ? "OpenAI" : "Anthropic";

const discoveredModelId = z.string().regex(/^[A-Za-z0-9._:/-]{1,200}$/);

const friendlyOpenAIModelName = (id: string): string => id
  .split("-")
  .filter(Boolean)
  .map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === "gpt") return "GPT";
    if (normalized === "codex") return "Codex";
    return /^o\d/.test(normalized) ? normalized.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  })
  .join(" ");

const openAIModelRoles = (id: string): ProviderModelOption["roles"] => {
  const roles: ProviderModelOption["roles"] = ["build", "review"];
  if (/(?:codex|gpt-4o|gpt-4\.1|gpt-5(?:\.(?:\d+))?|o3|o4)/i.test(id)
    && !/(?:mini|nano|audio|realtime|search)/i.test(id)) roles.push("qa");
  return roles;
};

const canRouteOpenAIModel = (id: string): boolean =>
  /^(?:gpt-|chatgpt-|o[134](?:-|$)|codex)/i.test(id)
  && !/(?:embedding|moderation|whisper|tts|transcri|audio|realtime|image|search|dall-e)/i.test(id);

const safeDiscoveryError = (provider: Exclude<Provider, "cursor">, error: unknown): string => {
  const fallback = `${providerLabel(provider)} model discovery is temporarily unavailable. Keep the cached list or try refresh again.`;
  if (!(error instanceof Error)) return fallback;
  return error.message
    .slice(0, 500)
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
};

export const createProviderModelDiscovery = (
  fetcher: typeof fetch = fetch,
): ProviderModelDiscovery => async (provider, credential) => {
  const target = provider === "codex"
    ? "https://api.openai.com/v1/models"
    : "https://api.anthropic.com/v1/models?limit=100";
  const headers = provider === "codex"
    ? { Authorization: `Bearer ${credential}` }
    : { "x-api-key": credential, "anthropic-version": "2023-06-01" };
  let response: Response;
  try {
    response = await fetcher(target, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`${providerLabel(provider)} model discovery is temporarily unavailable. Keep the cached list or try refresh again.`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${providerLabel(provider)} rejected this credential (${response.status}). Replace the key and refresh models.`);
    }
    if (response.status === 429) {
      throw new Error(`${providerLabel(provider)} model discovery is rate limited. Keep the cached list and try again later.`);
    }
    throw new Error(`${providerLabel(provider)} model discovery failed (${response.status}). Keep the cached list and try again.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${providerLabel(provider)} returned an invalid model list. Keep the cached list and try again.`);
  }
  if (provider === "codex") {
    const parsed = z.object({
      data: z.array(z.object({ id: discoveredModelId }).passthrough()).max(10_000),
    }).safeParse(payload);
    if (!parsed.success) throw new Error("OpenAI returned an invalid model list. Keep the cached list and try again.");
    return parsed.data.data
      .map(({ id }) => id)
      .filter(canRouteOpenAIModel)
      .map((id) => ({ id, name: friendlyOpenAIModelName(id), roles: openAIModelRoles(id) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  const parsed = z.object({
    data: z.array(z.object({
      id: discoveredModelId,
      display_name: z.string().trim().min(1).max(200),
    }).passthrough()).max(10_000),
  }).safeParse(payload);
  if (!parsed.success) throw new Error("Anthropic returned an invalid model list. Keep the cached list and try again.");
  return parsed.data.data
    .filter(({ id }) => /^claude-/i.test(id))
    .map(({ id, display_name: name }) => ({
      id,
      name,
      roles: ["build", "review", "qa"] as ProviderModelOption["roles"],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

type CreateControlPlaneOptions = {
  storage: ControlPlaneStorage;
  vault: CredentialVault;
  verifyCredential?: ProviderCredentialVerifier;
  provisionRepository?: (input: ProvisionRepositoryInput) => Promise<ProvisionRepositoryOutput>;
  syncProviderCredential?: (provider: Provider, credential: string) => Promise<void>;
  discoverModels?: ProviderModelDiscovery;
};

export const createControlPlane = ({
  storage,
  vault,
  verifyCredential = createProviderCredentialVerifier(),
  provisionRepository,
  syncProviderCredential,
  discoverModels,
}: CreateControlPlaneOptions): ControlPlane => ({
  getSnapshot() {
    return {
      providers: providers.map((provider) => {
        const stored = storage.getProviderCredential(provider);
        return {
          provider,
          configured: stored !== null,
          verification: stored === null ? "missing" : stored.verifiedAt ? "verified" : "configured",
          verifiedAt: stored?.verifiedAt || null,
        };
      }),
      modelCatalogs: providers.map((provider) => storage.getProviderModelCatalog(provider) ?? {
        provider,
        supportsDiscovery: provider !== "cursor",
        models: [],
        refreshedAt: null,
        lastError: null,
        lastErrorAt: null,
      }),
      routing: storage.getRoutingSettings(),
      routingSummary: storage.getRoutingSummary(),
      repositories: storage.listManagedRepositories(),
    };
  },

  getProviderCredentialValue(provider) {
    const stored = storage.getProviderCredential(provider);
    return stored ? vault.open(stored.sealed) : null;
  },

  async saveProviderCredential(provider, input, now = new Date()) {
    const credential = credentialSchema.parse(input);
    await verifyCredential(provider, credential);
    const timestamp = now.toISOString();
    storage.setProviderCredential(provider, {
      sealed: vault.seal(credential),
      verifiedAt: provider === "cursor" ? "" : timestamp,
      updatedAt: timestamp,
    });
    await syncProviderCredential?.(provider, credential);
    if (provider !== "cursor" && discoverModels) {
      try {
        await this.refreshProviderModels(provider, now);
      } catch {
        // The verified credential is still useful; the persisted discovery status explains the failure.
      }
    }
  },

  seedProviderCredential(provider, input, now = new Date()) {
    if (storage.getProviderCredential(provider)) return;
    const credential = credentialSchema.parse(input);
    storage.setProviderCredential(provider, {
      sealed: vault.seal(credential),
      verifiedAt: "",
      updatedAt: now.toISOString(),
    });
  },

  async refreshProviderModels(provider, now = new Date()) {
    if (provider === "cursor") {
      throw new Error("Cursor does not publish a model-list API. Enter an exact model ID in the advanced fallback.");
    }
    const stored = storage.getProviderCredential(provider);
    if (!stored) throw new Error(`${providerLabel(provider)} is not configured. Add its API key first.`);
    if (!discoverModels) throw new Error(`${providerLabel(provider)} model discovery is not configured on this service.`);
    const previous = storage.getProviderModelCatalog(provider);
    try {
      const models = await discoverModels(provider, vault.open(stored.sealed));
      storage.setProviderModelCatalog({
        provider,
        supportsDiscovery: true,
        models,
        refreshedAt: now.toISOString(),
        lastError: null,
        lastErrorAt: null,
      }, now.getTime());
    } catch (error) {
      const message = safeDiscoveryError(provider, error);
      storage.setProviderModelCatalog({
        provider,
        supportsDiscovery: true,
        models: previous?.models ?? [],
        refreshedAt: previous?.refreshedAt ?? null,
        lastError: message,
        lastErrorAt: now.toISOString(),
      }, now.getTime());
      throw new Error(message, { cause: error });
    }
  },

  saveRoutingSettings(settings) {
    const parsed = RoutingSettingsSchema.parse(settings);
    if (parsed.candidates.some((candidate) => !storage.getProviderCredential(candidate.provider))) {
      throw new Error("Every enabled route requires a connected provider credential");
    }
    storage.setRoutingSettings(parsed);
  },

  async provisionRepository(input) {
    if (!provisionRepository) throw new Error("Repository provisioning is not configured");
    return provisionRepository(input);
  },
});

type RepositoryProvisionerOptions = {
  storage: Pick<Storage, "getManagedRepository" | "saveManagedRepository">;
  appAccess: Pick<GitHubAppAccess, "getInstallationId" | "getApi" | "getAppSlug">;
  getCredential(provider: Provider): string | null;
  loadFiles(): Promise<Record<string, string>>;
  runProvision?: (options: ProvisionOptions) => Promise<ProvisionResult>;
  checkIntegrationId: number;
};

const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const CodeownerSchema = z.string().regex(/^@[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/);

const setupPullRequestNumber = (repository: string, url: string | null): number | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !match) return null;
    if (`${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) return null;
    return Number.parseInt(match[3]!, 10);
  } catch {
    return null;
  }
};

export const createRepositoryProvisioner = ({
  storage,
  appAccess,
  getCredential,
  loadFiles,
  runProvision = provisionRepository,
  checkIntegrationId,
}: RepositoryProvisionerOptions) => async (input: ProvisionRepositoryInput): Promise<ProvisionRepositoryOutput> => {
  const repository = RepositorySchema.parse(input.repository.trim());
  const codeowners = z.array(CodeownerSchema).min(1).max(20).parse(input.codeowners);
  const installationId = await appAccess.getInstallationId(repository);
  const [api, appSlug, files] = await Promise.all([
    appAccess.getApi(installationId),
    appAccess.getAppSlug(),
    loadFiles(),
  ]);
  const codex = getCredential("codex");
  const claude = getCredential("claude");
  const cursor = getCredential("cursor");
  const existing = storage.getManagedRepository(repository);
  let activationAuthorized = existing?.status === "active";
  const pullNumber = setupPullRequestNumber(repository, existing?.setupPullRequestUrl ?? null);
  if (!activationAuthorized && pullNumber !== null) {
    const pull = z.object({ merged_at: z.string().nullable() }).parse(
      (await api.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: repository.split("/")[0]!,
        repo: repository.split("/")[1]!,
        pull_number: pullNumber,
      })).data,
    );
    if (pull.merged_at !== null) {
      activationAuthorized = await verifyInstalledRepositoryKit({ repository, api, files, codeowners });
    }
  }
  if (!activationAuthorized && pullNumber === null) {
    activationAuthorized = await verifyInstalledRepositoryKit({ repository, api, files, codeowners });
  }
  const result = await runProvision({
    repository,
    api,
    files,
    secrets: {
      ...(activationAuthorized && codex ? { OPENAI_API_KEY: codex } : {}),
      ...(activationAuthorized && claude ? { ANTHROPIC_API_KEY: claude } : {}),
      ...(activationAuthorized && cursor ? { CURSOR_API_KEY: cursor } : {}),
    },
    variables: activationAuthorized ? {
      FLOW_BOT_LOGIN: `${appSlug}[bot]`,
    } : {},
    codeowners,
    checkIntegrationId,
    activationAuthorized,
  });
  const active = activationAuthorized && result.mergeGateInstalled;
  const setupPullRequestUrl = active
    ? null
    : result.setupPullRequestUrl ?? existing?.setupPullRequestUrl ?? null;
  const updatedAt = new Date().toISOString();
  storage.saveManagedRepository({
    repository,
    installationId,
    codeowners,
    setupPullRequestUrl,
    mergeGateInstalled: active,
    updatedAt,
  });
  return {
    repository,
    setupPullRequestUrl,
    mergeGateInstalled: active,
    status: active ? "active" : "pending",
  };
};

const providerSecretName: Record<Provider, string> = {
  codex: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  cursor: "CURSOR_API_KEY",
};

export const createRepositoryCredentialSync = (options: {
  storage: Pick<Storage, "listManagedRepositories">;
  appAccess: Pick<GitHubAppAccess, "getApi">;
  setSecret?: typeof setRepositoryActionsSecret;
}) => async (provider: Provider, credential: string): Promise<void> => {
  const setSecret = options.setSecret ?? setRepositoryActionsSecret;
  for (const repository of options.storage.listManagedRepositories()) {
    if (repository.status !== "active") continue;
    const api = await options.appAccess.getApi(repository.installationId);
    await setSecret({
      repository: repository.repository,
      api,
      name: providerSecretName[provider],
      value: credential,
    });
  }
};
