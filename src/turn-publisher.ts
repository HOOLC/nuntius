import type {
  ConversationBinding,
  ConversationLanguage,
  InboundTurn,
  OutboundMessage
} from "./domain.js";

export interface TurnPublisher {
  publishQueued(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  publishStarted(
    turn: InboundTurn,
    binding: ConversationBinding,
    note: string | undefined,
    language: ConversationLanguage
  ): Promise<void>;
  publishProgress(turn: InboundTurn, message: string, language: ConversationLanguage): Promise<void>;
  publishCompleted(turn: InboundTurn, message: OutboundMessage, language: ConversationLanguage): Promise<void>;
  publishInterrupted(turn: InboundTurn, message: string, language: ConversationLanguage): Promise<void>;
  publishFailed(turn: InboundTurn, errorMessage: string, language: ConversationLanguage): Promise<void>;
  refreshWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  showWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
  hideWorkingIndicator?(turn: InboundTurn, language: ConversationLanguage): Promise<void>;
}
