import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import sodium from "libsodium-wrappers";
import { z } from "zod";
import type { GitHubApi } from "./github.js";

type EncryptSecret = (value: string, publicKey: string) => Promise<string>;

export type ProvisionOptions = {
  repository: string;
  api: GitHubApi;
  files: Record<string, string>;
  secrets: Record<string, string>;
  variables: Record<string, string>;
  codeowners: string[];
  checkIntegrationId: number;
  encryptSecret?: EncryptSecret;
};

export type ProvisionResult = {
  defaultBranch: string;
  commitSha: string;
  setupPullRequestUrl?: string;
  mergeGateInstalled: boolean;
};

const splitRepository = (repository: string): { owner: string; repo: string } => {
  const match = repository.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
};

const statusOf = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
};

export const encryptGitHubSecret: EncryptSecret = async (value, publicKey) => {
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
};

export const loadRepositoryKit = async (root: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
};

const mergeAgentInstructions = async (
  api: GitHubApi,
  owner: string,
  repo: string,
  files: Record<string, string>,
): Promise<Record<string, string>> => {
  const merged = { ...files };
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    if (!(path in merged)) continue;
    try {
      const response = await api.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
      });
      const existing = z.object({
        type: z.literal("file"),
        content: z.string(),
      }).parse(response.data);
      const content = Buffer.from(existing.content.replace(/\s/g, ""), "base64").toString("utf8");
      merged[path] = content.includes(".flow/AI_RULES.md")
        ? content
        : `${content.trimEnd()}\n\n## Flow AI\n\nRead and follow \`.flow/AI_RULES.md\` before planning, editing, testing, or reviewing work.\n`;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  const codeownersPath = ".github/CODEOWNERS";
  if (codeownersPath in merged) {
    try {
      const response = await api.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: codeownersPath,
      });
      const existing = z.object({ type: z.literal("file"), content: z.string() }).parse(response.data);
      const content = Buffer.from(existing.content.replace(/\s/g, ""), "base64").toString("utf8");
      const flowBlock = merged[codeownersPath]!;
      const blockPattern = /\n?# BEGIN Flow AI required human reviewers[\s\S]*?# END Flow AI required human reviewers\n?/;
      merged[codeownersPath] = blockPattern.test(content)
        ? content.replace(blockPattern, `\n${flowBlock.trim()}\n`)
        : `${content.trimEnd()}\n\n${flowBlock}`;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
  return merged;
};

const upsertVariable = async (
  api: GitHubApi,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> => {
  try {
    await api.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
      owner,
      repo,
      name,
      value,
    });
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    await api.request("POST /repos/{owner}/{repo}/actions/variables", {
      owner,
      repo,
      name,
      value,
    });
  }
};

const flowLabels: Record<string, string> = {
  "flow:inbox": "6f42c1",
  "flow:ready": "1d76db",
  "flow:working": "fbca04",
  "flow:blocked": "d93f0b",
  "flow:human": "0e8a16",
  "flow:done": "5319e7",
};

const installMergeGate = async (
  api: GitHubApi,
  owner: string,
  repo: string,
  checkIntegrationId: number,
): Promise<void> => {
  const rulesets = z.array(z.object({ id: z.number().int(), name: z.string() })).parse(
    (await api.request("GET /repos/{owner}/{repo}/rulesets", { owner, repo })).data,
  );
  const existing = rulesets.find((ruleset) => ruleset.name === "Flow AI human approval gate");
  const settings = {
    owner,
    repo,
    name: "Flow AI human approval gate",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: true,
          strict_required_status_checks_policy: true,
          required_status_checks: ["ci", "ai-review", "qa"].map((context) => ({
            context,
            integration_id: checkIntegrationId,
          })),
        },
      },
    ],
  };
  if (existing) {
    await api.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      ...settings,
      ruleset_id: existing.id,
    });
  } else {
    await api.request("POST /repos/{owner}/{repo}/rulesets", settings);
  }
};

export const provisionRepository = async (options: ProvisionOptions): Promise<ProvisionResult> => {
  const { owner, repo } = splitRepository(options.repository);
  const repository = z.object({ default_branch: z.string().min(1) }).parse(
    (await options.api.request("GET /repos/{owner}/{repo}", { owner, repo })).data,
  );
  const ref = z.object({ object: z.object({ sha: z.string().min(1) }) }).parse(
    (await options.api.request("GET /repos/{owner}/{repo}/git/ref/heads/{ref}", {
      owner,
      repo,
      ref: repository.default_branch,
    })).data,
  );
  const commit = z.object({ tree: z.object({ sha: z.string().min(1) }) }).parse(
    (await options.api.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: ref.object.sha,
    })).data,
  );
  let alreadyInstalled = false;
  try {
    await options.api.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: ".github/workflows/flow-build.yml",
      ref: repository.default_branch,
    });
    alreadyInstalled = true;
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  const setupHead = `${owner}:flow/setup`;
  const existingSetup = alreadyInstalled ? undefined : z.array(z.object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
  })).parse((await options.api.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    state: "open",
    head: setupHead,
    base: repository.default_branch,
  })).data)[0];
  if (options.codeowners.length === 0) throw new Error("At least one human CODEOWNER is required");
  const ownerLine = options.codeowners.join(" ");
  const renderedFiles = Object.fromEntries(Object.entries(options.files).map(([path, content]) => [
    path,
    content.replaceAll("{{FLOW_CODEOWNERS}}", ownerLine),
  ]));
  const files = await mergeAgentInstructions(options.api, owner, repo, renderedFiles);
  let commitSha = ref.object.sha;
  let setupPullRequest = existingSetup;
  if (!alreadyInstalled) {
    const tree = z.object({ sha: z.string().min(1) }).parse(
      (await options.api.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: commit.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644",
          type: "blob",
          content,
        })),
      })).data,
    );
    const newCommit = z.object({ sha: z.string().min(1) }).parse(
      (await options.api.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: "chore: install Flow AI automation",
        tree: tree.sha,
        parents: [ref.object.sha],
      })).data,
    );
    commitSha = newCommit.sha;
    try {
      await options.api.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo,
        ref: "refs/heads/flow/setup",
        sha: newCommit.sha,
      });
    } catch (error) {
      if (statusOf(error) !== 422) throw error;
      await options.api.request("PATCH /repos/{owner}/{repo}/git/refs/heads/{ref}", {
        owner,
        repo,
        ref: "flow/setup",
        sha: newCommit.sha,
        force: true,
      });
    }
    if (!setupPullRequest) {
      setupPullRequest = z.object({
        number: z.number().int().positive(),
        html_url: z.string().url(),
      }).parse((await options.api.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        head: "flow/setup",
        base: repository.default_branch,
        title: "Install Flow AI automation",
        body: "Installs the reviewed Flow AI contract, workflows, and repository guidance.",
      })).data);
    }
  }

  await options.api.request("PUT /repos/{owner}/{repo}/actions/permissions/workflow", {
    owner,
    repo,
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });

  const publicKey = z.object({ key: z.string(), key_id: z.string() }).parse(
    (await options.api.request("GET /repos/{owner}/{repo}/actions/secrets/public-key", {
      owner,
      repo,
    })).data,
  );
  const encrypt = options.encryptSecret ?? encryptGitHubSecret;
  for (const [name, value] of Object.entries(options.secrets)) {
    await options.api.request("PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}", {
      owner,
      repo,
      secret_name: name,
      encrypted_value: await encrypt(value, publicKey.key),
      key_id: publicKey.key_id,
    });
  }
  for (const [name, value] of Object.entries(options.variables)) {
    await upsertVariable(options.api, owner, repo, name, value);
  }
  for (const [name, color] of Object.entries(flowLabels)) {
    try {
      await options.api.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name,
        color,
      });
    } catch (error) {
      if (statusOf(error) !== 422) throw error;
    }
  }
  let mergeGateInstalled = alreadyInstalled;
  if (alreadyInstalled) {
    await installMergeGate(options.api, owner, repo, options.checkIntegrationId);
  } else if (setupPullRequest) try {
    const merge = z.object({ merged: z.boolean(), sha: z.string().optional() }).parse((await options.api.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner,
        repo,
        pull_number: setupPullRequest.number,
        merge_method: "squash",
        commit_title: "chore: install Flow AI automation",
      },
    )).data);
    if (merge.merged) {
      commitSha = merge.sha ?? commitSha;
      await installMergeGate(options.api, owner, repo, options.checkIntegrationId);
      mergeGateInstalled = true;
    }
  } catch (error) {
    if (![405, 409].includes(statusOf(error) ?? 0)) throw error;
  }

  return {
    defaultBranch: repository.default_branch,
    commitSha,
    mergeGateInstalled,
    ...(setupPullRequest ? { setupPullRequestUrl: setupPullRequest.html_url } : {}),
  };
};
