export const FLOW_STATES = ["inbox", "ready", "working", "blocked", "human", "done"] as const;

export type Provider = "codex" | "claude" | "cursor";
export type FlowState = (typeof FLOW_STATES)[number];

export type FeedbackItem =
  | { kind: "text"; text: string }
  | {
      kind: "photo" | "document" | "voice" | "video";
      fileId: string;
      mimeType?: string;
      caption?: string;
      fileSize?: number;
    };

export type FeedbackBundle = {
  source: {
    chatId: string;
    topicId: string | null;
    userId: string;
    messageIds: number[];
  };
  repository: string;
  items: FeedbackItem[];
};

export type WorkUnit = {
  title: string;
  body: string;
  canRunInParallel: boolean;
};

export type WorkPlan = {
  title: string;
  problem: string;
  evidence: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  risks: string[];
  needsHumanInput: boolean;
  units: WorkUnit[];
};
