import type { FeedbackBundle, FlowState, Provider, WorkPlan } from "./domain.js";
import { buildWorkPlan, prepareFeedback, type IntakeModel } from "./intake.js";
import type { PlannedIssueResult } from "./github.js";
import type { Storage } from "./storage.js";
import type { ParsedTelegramUpdate, TelegramClient } from "./telegram.js";

export type RequiredCheck = "ci" | "ai-review" | "qa";

export type WorkSnapshot = {
  state: FlowState;
  fixRounds: number;
  headSha: string | null;
  passedChecks: string[];
};

export type WorkEvent =
  | { type: "pr_opened"; pullRequestNumber: number; headSha: string }
  | { type: "check_passed"; name: RequiredCheck; headSha: string }
  | { type: "check_failed"; name: RequiredCheck; headSha: string; summary: string }
  | { type: "merged" };

export type OrchestrationCommand =
  | { type: "request_fix"; summary: string; attempt: number }
  | { type: "set_state"; state: FlowState }
  | { type: "notify"; message: string }
  | { type: "close_issue" };

export type TransitionResult = {
  work: WorkSnapshot;
  commands: OrchestrationCommand[];
};

const requiredChecks: RequiredCheck[] = ["ci", "ai-review", "qa"];

export const transition = (
  work: WorkSnapshot,
  event: WorkEvent,
  maxFixRounds: number,
): TransitionResult => {
  if ("headSha" in event && work.headSha !== null && event.headSha !== work.headSha) {
    return { work, commands: [] };
  }

  if (event.type === "pr_opened") {
    return {
      work: { ...work, state: "working", headSha: event.headSha, passedChecks: [] },
      commands: [{ type: "notify", message: `Pull request #${event.pullRequestNumber} opened.` }],
    };
  }

  if (event.type === "check_passed") {
    const passedChecks = [...new Set([...work.passedChecks, event.name])];
    if (requiredChecks.every((check) => passedChecks.includes(check))) {
      return {
        work: { ...work, state: "human", passedChecks },
        commands: [
          { type: "set_state", state: "human" },
          { type: "notify", message: "All checks passed. Ready for human approval." },
        ],
      };
    }
    return { work: { ...work, passedChecks }, commands: [] };
  }

  if (event.type === "check_failed") {
    if (work.fixRounds < maxFixRounds) {
      const attempt = work.fixRounds + 1;
      return {
        work: { ...work, state: "working", fixRounds: attempt, passedChecks: [] },
        commands: [
          { type: "request_fix", summary: `${event.name}: ${event.summary}`, attempt },
          { type: "notify", message: `${event.name} failed. Automatic fix round ${attempt} started.` },
        ],
      };
    }
    return {
      work: { ...work, state: "blocked", passedChecks: [] },
      commands: [
        { type: "set_state", state: "blocked" },
        { type: "notify", message: `${event.name} is still failing after ${maxFixRounds} fix rounds.` },
      ],
    };
  }

  return {
    work: { ...work, state: "done" },
    commands: [
      { type: "set_state", state: "done" },
      { type: "close_issue" },
      { type: "notify", message: "Pull request merged." },
    ],
  };
};

type TelegramOrchestrationStorage = Pick<
  Storage,
  | "bindChat"
  | "getChatBinding"
  | "startDraft"
  | "appendDraftItem"
  | "getOpenDraft"
  | "closeDraft"
  | "linkWork"
  | "enqueueNotification"
>;

type TelegramGitHubGateway = {
  hasRepositoryAccess(repository: string): Promise<{ installationId: number }>;
  createPlannedIssue(
    repository: string,
    plan: WorkPlan,
    source: FeedbackBundle["source"],
  ): Promise<PlannedIssueResult>;
  dispatchBuild?(repository: string, issueNumber: number): Promise<void>;
};

export type TelegramOrchestrationDependencies = {
  storage: TelegramOrchestrationStorage;
  adminIds: string[];
  telegram: TelegramClient;
  transcribe(bytes: Buffer, mimeType: string): Promise<string>;
  model: IntakeModel;
  github: TelegramGitHubGateway;
  builder?: Provider;
};

const notificationKey = (update: ParsedTelegramUpdate, suffix: string): string =>
  `telegram:${update.updateId}:${suffix}`;

const notify = (
  update: ParsedTelegramUpdate,
  dependencies: TelegramOrchestrationDependencies,
  suffix: string,
  text: string,
): void => {
  dependencies.storage.enqueueNotification(
    notificationKey(update, suffix),
    update.chatId,
    update.topicId,
    text,
  );
};

export const processTelegramUpdate = async (
  update: ParsedTelegramUpdate,
  dependencies: TelegramOrchestrationDependencies,
): Promise<void> => {
  const { action } = update;
  if (action.type === "connect") {
    if (!dependencies.adminIds.includes(update.userId)) {
      notify(update, dependencies, "unauthorized", "Only a configured administrator can connect a repository.");
      return;
    }
    const access = await dependencies.github.hasRepositoryAccess(action.repository);
    dependencies.storage.bindChat(
      update.chatId,
      update.topicId,
      access.installationId,
      action.repository,
    );
    notify(update, dependencies, "connected", `Connected to <b>${action.repository}</b>.`);
    return;
  }

  if (action.type === "new") {
    dependencies.storage.startDraft(update.chatId, update.topicId, update.userId);
    notify(update, dependencies, "draft", "New request started. Send text, screenshots, documents, or voice notes, then use /ship.");
    return;
  }

  if (action.type === "append") {
    const draft = dependencies.storage.getOpenDraft(
      update.chatId,
      update.topicId,
      update.userId,
    );
    const draftId = draft?.id ?? dependencies.storage.startDraft(
      update.chatId,
      update.topicId,
      update.userId,
    );
    dependencies.storage.appendDraftItem(draftId, update.messageId, action.item);
    notify(update, dependencies, "added", "Added to the request. Send more feedback or use /ship.");
    return;
  }

  if (action.type === "cancel") {
    const draft = dependencies.storage.getOpenDraft(update.chatId, update.topicId, update.userId);
    if (draft) dependencies.storage.closeDraft(draft.id, "cancelled");
    notify(update, dependencies, "cancelled", "Request discarded.");
    return;
  }

  if (action.type === "status") {
    const binding = dependencies.storage.getChatBinding(update.chatId, update.topicId);
    notify(
      update,
      dependencies,
      "status",
      binding ? `Connected to <b>${binding.repository}</b>.` : "No repository is connected here.",
    );
    return;
  }

  const binding = dependencies.storage.getChatBinding(update.chatId, update.topicId);
  const draft = dependencies.storage.getOpenDraft(update.chatId, update.topicId, update.userId);
  if (!binding || !draft || draft.items.length === 0) {
    notify(update, dependencies, "cannot-submit", "Connect a repository and add feedback before using /ship.");
    return;
  }

  const bundle: FeedbackBundle = {
    source: {
      chatId: draft.chatId,
      topicId: draft.topicId,
      userId: draft.userId,
      messageIds: draft.messageIds,
    },
    repository: binding.repository,
    items: draft.items,
  };
  const prepared = await prepareFeedback(bundle, {
    downloadFile: dependencies.telegram.downloadFile,
    transcribe: dependencies.transcribe,
  });
  const plan = await buildWorkPlan(bundle, {}, dependencies.model, prepared);
  const result = await dependencies.github.createPlannedIssue(binding.repository, plan, bundle.source);
  dependencies.storage.closeDraft(draft.id, "submitted");

  const parentState: FlowState = plan.needsHumanInput
    ? "blocked"
    : result.childNumbers.length > 0
      ? "inbox"
      : "ready";
  dependencies.storage.linkWork({
    repository: binding.repository,
    issueNumber: result.parentNumber,
    chatId: update.chatId,
    topicId: update.topicId,
    pullRequestNumber: null,
    providerJobId: null,
    fixRounds: 0,
    state: parentState,
    headSha: null,
    passedChecks: [],
  });

  for (const issueNumber of result.childNumbers) {
    dependencies.storage.linkWork({
      repository: binding.repository,
      issueNumber,
      chatId: update.chatId,
      topicId: update.topicId,
      pullRequestNumber: null,
      providerJobId: null,
      fixRounds: 0,
      state: "ready",
      headSha: null,
      passedChecks: [],
    });
  }

  if (!plan.needsHumanInput && dependencies.builder !== "cursor" && dependencies.github.dispatchBuild) {
    const buildIssues = result.childNumbers.length > 0 ? result.childNumbers : [result.parentNumber];
    await Promise.all(buildIssues.map((issueNumber) =>
      dependencies.github.dispatchBuild!(binding.repository, issueNumber)));
  }

  const issueUrl = `https://github.com/${binding.repository}/issues/${result.parentNumber}`;
  const units = result.childNumbers.length > 0 ? ` with ${result.childNumbers.length} parallel work units` : "";
  notify(update, dependencies, "submitted", `Created <a href="${issueUrl}">GitHub issue #${result.parentNumber}</a>${units}.`);
};
