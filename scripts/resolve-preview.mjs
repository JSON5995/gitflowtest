#!/usr/bin/env node
/* global AbortSignal, URL, fetch, process */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/;

const required = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
};

const exactCommit = (value) => {
  const commit = required(value, "FLOW_PREVIEW_COMMIT");
  if (!commitPattern.test(commit)) throw new Error("FLOW_PREVIEW_COMMIT must be a full lowercase commit SHA");
  return commit;
};

const httpsUrl = (value) => {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:") throw new Error("Preview URL must use HTTPS");
  return url.toString();
};

const requestJson = async (provider, fetcher, url, init) => {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`${provider} API request failed with ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${provider} API returned invalid JSON`);
  }
};

const previewEvidence = (input) => {
  const url = httpsUrl(required(input.url, "preview URL"));
  const commitSha = exactCommit(input.commitSha);
  if (input.state !== "ready") throw new Error("Exact preview is not ready");
  return {
    version: 1,
    provider: input.provider,
    kind: "web",
    projectId: required(input.projectId, "preview project ID"),
    resourceId: required(input.resourceId, "preview resource ID"),
    resourceName: required(input.resourceName, "preview resource name"),
    commitSha,
    revisionVerified: true,
    url,
    state: "ready",
    createdAt: new Date(input.createdAt).toISOString(),
    observedAt: (input.now ?? new Date()).toISOString(),
  };
};

export const resolveVercelPreview = async ({ env, fetcher = fetch, now = new Date() }) => {
  const token = required(env.VERCEL_TOKEN, "VERCEL_TOKEN");
  const projectId = required(env.FLOW_PREVIEW_PROJECT_ID, "FLOW_PREVIEW_PROJECT_ID");
  const commitSha = exactCommit(env.FLOW_PREVIEW_COMMIT);
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("target", "preview");
  url.searchParams.set("limit", "20");
  if (env.FLOW_VERCEL_TEAM_ID) url.searchParams.set("teamId", env.FLOW_VERCEL_TEAM_ID);
  const payload = await requestJson("vercel", fetcher, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const deployments = Array.isArray(payload?.deployments) ? payload.deployments : [];
  const deployment = deployments
    .filter((item) => item?.projectId === projectId && item?.target !== "production")
    .filter((item) => item?.meta?.githubCommitSha === commitSha)
    .filter((item) => item?.state === "READY")
    .sort((left, right) => Number(right.created) - Number(left.created))[0];
  if (!deployment) throw new Error("Vercel has no ready preview for the exact pull request commit");
  return previewEvidence({
    provider: "vercel",
    projectId,
    resourceId: String(deployment.uid ?? ""),
    resourceName: String(deployment.name ?? deployment.uid ?? ""),
    commitSha,
    url: String(deployment.url ?? ""),
    state: "ready",
    createdAt: Number(deployment.created),
    now,
  });
};

export const resolveRailwayPreview = async ({ env, fetcher = fetch, now = new Date() }) => {
  const token = required(env.RAILWAY_TOKEN, "RAILWAY_TOKEN");
  const tokenKind = env.FLOW_RAILWAY_TOKEN_KIND === "account" ? "account" : "project";
  const projectId = required(env.FLOW_PREVIEW_PROJECT_ID, "FLOW_PREVIEW_PROJECT_ID");
  const environmentId = required(env.FLOW_RAILWAY_ENVIRONMENT_ID, "FLOW_RAILWAY_ENVIRONMENT_ID");
  const serviceId = required(env.FLOW_RAILWAY_SERVICE_ID, "FLOW_RAILWAY_SERVICE_ID");
  const publicUrl = httpsUrl(required(env.FLOW_RAILWAY_PUBLIC_URL, "FLOW_RAILWAY_PUBLIC_URL"));
  const commitSha = exactCommit(env.FLOW_PREVIEW_COMMIT);
  const query = `query FlowDeployments($input: DeploymentListInput!, $first: Int) {
    deployments(input: $input, first: $first) { edges { node { id status createdAt meta } } }
  }`;
  const tokenHeader = tokenKind === "account"
    ? { Authorization: `Bearer ${token}` }
    : { "Project-Access-Token": token };
  const payload = await requestJson("railway", fetcher, "https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { ...tokenHeader, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query,
      variables: { input: { projectId, environmentId, serviceId }, first: 50 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error("railway API returned a GraphQL error");
  }
  const deployments = Array.isArray(payload?.data?.deployments?.edges)
    ? payload.data.deployments.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
  const deployment = deployments
    .filter((item) => item?.meta?.commitHash === commitSha)
    .filter((item) => item?.status === "SUCCESS")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (!deployment) throw new Error("Railway has no successful deployment for the exact pull request commit");
  return previewEvidence({
    provider: "railway",
    projectId,
    resourceId: String(deployment.id ?? ""),
    resourceName: serviceId,
    commitSha,
    url: publicUrl,
    state: "ready",
    createdAt: deployment.createdAt,
    now,
  });
};

const isolatedSupabaseBranch = (branch, expected) => Boolean(
  branch
  && branch.id === expected.resourceId
  && branch.name === expected.name
  && branch.git_branch === expected.gitBranch
  && branch.is_default === false
  && branch.persistent === false
  && branch.with_data === false,
);

export const createSupabaseBranchAdapter = ({ env, fetcher = fetch, now = () => new Date() }) => {
  const token = required(env.SUPABASE_ACCESS_TOKEN, "SUPABASE_ACCESS_TOKEN");
  const projectRef = required(env.FLOW_SUPABASE_PROJECT_REF, "FLOW_SUPABASE_PROJECT_REF");
  if (!/^[A-Za-z0-9_-]+$/.test(projectRef)) throw new Error("FLOW_SUPABASE_PROJECT_REF is invalid");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/branches`;
  const list = async () => {
    const branches = await requestJson("supabase", fetcher, endpoint, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!Array.isArray(branches)) throw new Error("supabase API returned an invalid branch list");
    return branches;
  };
  const evidence = (branch, commitSha) => ({
    version: 1,
    provider: "supabase",
    kind: "database",
    projectId: projectRef,
    resourceId: String(branch.id),
    resourceName: String(branch.name),
    commitSha,
    revisionVerified: false,
    state: branch.preview_project_status === "ACTIVE_HEALTHY" || branch.status === "MIGRATIONS_PASSED"
      ? "ready"
      : String(branch.status).includes("FAILED") ? "failed" : "building",
    createdAt: new Date(branch.created_at).toISOString(),
    observedAt: now().toISOString(),
  });
  return {
    async provision({ commitSha: rawCommit, gitBranch: rawBranch, pullRequestNumber: rawNumber }) {
      const commitSha = exactCommit(rawCommit);
      const gitBranch = required(rawBranch, "git branch");
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(gitBranch)) throw new Error("git branch is invalid");
      const pullRequestNumber = Number(rawNumber);
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("pull request number is invalid");
      const name = `flow-pr-${pullRequestNumber}-${commitSha.slice(0, 12)}`;
      const existing = (await list()).find((branch) => branch?.name === name);
      if (existing) {
        if (!isolatedSupabaseBranch(existing, { resourceId: existing.id, name, gitBranch })) {
          throw new Error("Existing Supabase branch is outside Flow's isolated branch contract");
        }
        return evidence(existing, commitSha);
      }
      const branch = await requestJson("supabase", fetcher, endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ branch_name: name, git_branch: gitBranch, persistent: false, with_data: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!isolatedSupabaseBranch(branch, { resourceId: branch?.id, name, gitBranch })) {
        throw new Error("Supabase created a branch outside Flow's isolated branch contract");
      }
      return evidence(branch, commitSha);
    },
    async cleanup({ commitSha: rawCommit, gitBranch: rawBranch, pullRequestNumber: rawNumber, resourceId: rawId }) {
      const commitSha = exactCommit(rawCommit);
      const gitBranch = required(rawBranch, "git branch");
      const resourceId = required(rawId, "Supabase branch ID");
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(gitBranch) || !/^[A-Za-z0-9_-]+$/.test(resourceId)) {
        throw new Error("Supabase cleanup identifiers are invalid");
      }
      const pullRequestNumber = Number(rawNumber);
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("pull request number is invalid");
      const name = `flow-pr-${pullRequestNumber}-${commitSha.slice(0, 12)}`;
      const branch = (await list()).find((item) => item?.id === resourceId);
      if (!branch) return;
      if (!isolatedSupabaseBranch(branch, { resourceId, name, gitBranch })) {
        throw new Error("Refusing to delete a Supabase branch outside Flow's isolated branch contract");
      }
      const response = await fetcher(`https://api.supabase.com/v1/branches/${encodeURIComponent(resourceId)}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`supabase API request failed with ${response.status}`);
    },
  };
};

export const resolvePreview = async (options) => {
  const provider = required(options.env.FLOW_PREVIEW_PROVIDER, "FLOW_PREVIEW_PROVIDER").toLowerCase();
  if (provider === "vercel") return resolveVercelPreview(options);
  if (provider === "railway") return resolveRailwayPreview(options);
  throw new Error("FLOW_PREVIEW_PROVIDER must be vercel or railway");
};

const run = async () => {
  const evidenceIndex = process.argv.indexOf("--evidence");
  const outputIndex = process.argv.indexOf("--github-output");
  const evidencePath = resolve(evidenceIndex >= 0 ? required(process.argv[evidenceIndex + 1], "--evidence") : ".flow/evidence/platform.json");
  const outputPath = outputIndex >= 0 ? required(process.argv[outputIndex + 1], "--github-output") : undefined;
  const evidence = await resolvePreview({ env: process.env });
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  if (outputPath) await writeFile(outputPath, `preview_url=${evidence.url}\n`, { flag: "a" });
  process.stdout.write(`${evidence.url}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Preview resolution failed"}\n`);
    process.exitCode = 1;
  });
}
