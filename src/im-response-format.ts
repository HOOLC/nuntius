import type { ChatPlatform } from "./domain.js";

export function buildImReplyFormatRules(platform: ChatPlatform): string[] {
  const lines = [
    "Reply formatting:",
    "- Do not use Markdown tables in user-visible replies.",
    "- Use short paragraphs, simple lists, and fenced code blocks instead.",
    "- Prefer chat-friendly plain text structure over complex Markdown layout."
  ];

  if (platform === "feishu") {
    lines.push(
      "- Feishu delivery is especially plain-text oriented, so keep sections short and labels explicit."
    );
  }

  lines.push("");
  return lines;
}
