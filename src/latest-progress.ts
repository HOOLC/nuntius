import { localize } from "./conversation-language.js";
import type { ConversationLanguage } from "./domain.js";

const TOOL_SUMMARY_PREFIXES = ["🤖 ", "🔍 ", "📖 ", "⚙️ ", "✏️ "];

export interface LatestProgressParts {
  latestMessage?: string;
  toolSummary?: string;
}

export function splitLatestProgressMessage(message: string): LatestProgressParts {
  const normalized = message.trim();
  if (!normalized) {
    return {};
  }

  if (isToolSummaryBlock(normalized)) {
    return {
      toolSummary: normalized
    };
  }

  const parts = normalized.split(/\n{2,}/);
  const lastPart = parts.at(-1)?.trim();
  if (lastPart && isToolSummaryBlock(lastPart)) {
    const latestMessage = parts.slice(0, -1).join("\n\n").trim();
    return {
      latestMessage: latestMessage || undefined,
      toolSummary: lastPart
    };
  }

  return {
    latestMessage: normalized
  };
}

export function buildInitialToolSummary(language: ConversationLanguage): string {
  return localize(language, {
    en: "🧰 0 tool updates",
    zh: "🧰 0 次工具更新"
  });
}

function isToolSummaryBlock(message: string): boolean {
  return message
    .split(" · ")
    .map((part) => part.trim())
    .every((part) => TOOL_SUMMARY_PREFIXES.some((prefix) => part.startsWith(prefix)));
}
