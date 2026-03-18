import type { ConversationBinding, ConversationLanguage } from "./domain.js";

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u;

export function detectConversationLanguage(text: string | undefined): ConversationLanguage {
  if (!text) {
    return "en";
  }

  return HAN_CHARACTER_PATTERN.test(text) ? "zh" : "en";
}

export function resolveConversationLanguage(input: {
  binding?: Pick<ConversationBinding, "language"> | undefined;
  text?: string | undefined;
}): ConversationLanguage {
  return input.binding?.language ?? detectConversationLanguage(input.text);
}

export function localize<T>(
  language: ConversationLanguage,
  messages: {
    en: T;
    zh: T;
  }
): T {
  return language === "zh" ? messages.zh : messages.en;
}

export function describeConversationLanguage(language: ConversationLanguage): string {
  return localize(language, {
    en: "English",
    zh: "Simplified Chinese"
  });
}
