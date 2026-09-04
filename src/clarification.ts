import { z } from "zod";
import type { ClarificationAnswer, ClarificationRequest } from "./domain.js";

const ClarificationRequestSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(200),
  source: z.enum(["intake", "builder"]),
  question: z.string().trim().min(3).max(1_000),
  context: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const ClarificationAnswerSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(200),
  answer: z.string().trim().min(1).max(4_000),
}).strict();

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decode = (encoded: string): unknown =>
  JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;

const machineMarker = (
  kind: "clarification" | "answer",
  value: ClarificationRequest | ClarificationAnswer,
): string => `<!-- flow-${kind}:v1:${encode(value)} -->`;

const escapeMarkdownHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const parseMarker = <T>(
  body: string,
  kind: "clarification" | "answer",
  parse: (value: unknown) => T,
): T | null => {
  const marker = body.match(new RegExp(`<!-- flow-${kind}:v1:([A-Za-z0-9_-]{4,8192}) -->`));
  if (!marker?.[1]) return null;
  try {
    return parse(decode(marker[1]));
  } catch {
    return null;
  }
};

export const formatClarificationComment = (input: ClarificationRequest): string => {
  const request = ClarificationRequestSchema.parse(input);
  const context = request.context
    ? `\n\nContext: ${escapeMarkdownHtml(request.context)}`
    : "";
  return `## Flow clarification needed\n\n${escapeMarkdownHtml(request.question)}${context}\n\nReply in this issue as a collaborator with write access, or use \`/answer ISSUE_NUMBER your answer\` in the connected Telegram topic.\n\n<!-- flow-clarification:v1:${encode(request)} -->`;
};

export const parseClarificationComment = (body: string): ClarificationRequest | null =>
  parseMarker(body, "clarification", (value) => ClarificationRequestSchema.parse(value));

export const formatClarificationAnswerComment = (input: ClarificationAnswer): string => {
  const answer = ClarificationAnswerSchema.parse(input);
  return `## Flow clarification answer\n\n${escapeMarkdownHtml(answer.answer)}\n\n<!-- flow-answer:v1:${encode(answer)} -->`;
};

export const parseClarificationAnswerComment = (body: string): ClarificationAnswer | null =>
  parseMarker(body, "answer", (value) => ClarificationAnswerSchema.parse(value));

export const sanitizeFlowComment = (
  body: string,
  sanitizeText: (value: string) => string,
): string => {
  const markerPattern = /<!-- flow-(clarification|answer):v1:([\s\S]*?)\s*-->/g;
  let result = "";
  let end = 0;

  for (const match of body.matchAll(markerPattern)) {
    const start = match.index;
    result += sanitizeText(body.slice(end, start));
    const kind = match[1];
    const marker = match[0];

    if (kind === "clarification") {
      const parsed = parseClarificationComment(marker);
      if (parsed) {
        const sanitized = ClarificationRequestSchema.safeParse({
          ...parsed,
          question: sanitizeText(parsed.question),
          ...(parsed.context ? { context: sanitizeText(parsed.context) } : {}),
        });
        result += sanitized.success
          ? machineMarker("clarification", sanitized.data)
          : "<!-- flow-invalid-marker -->";
      } else {
        result += "<!-- flow-invalid-marker -->";
      }
    } else {
      const parsed = parseClarificationAnswerComment(marker);
      if (parsed) {
        const sanitized = ClarificationAnswerSchema.safeParse({
          ...parsed,
          answer: sanitizeText(parsed.answer),
        });
        result += sanitized.success
          ? machineMarker("answer", sanitized.data)
          : "<!-- flow-invalid-marker -->";
      } else {
        result += "<!-- flow-invalid-marker -->";
      }
    }
    end = start + marker.length;
  }

  return result + sanitizeText(body.slice(end));
};
