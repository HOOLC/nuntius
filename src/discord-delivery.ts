export const DISCORD_MESSAGE_LIMIT = 1900;

export interface DiscordEditableMessage {
  edit(content: string): Promise<unknown>;
}

export interface DiscordSendableChannel {
  send(content: string): Promise<unknown>;
  sendTyping?(): Promise<void>;
}

export interface DiscordInteractionDeliveryState {
  initialResponseSent: boolean;
}

export interface DiscordInteractionResponder {
  deferred: boolean;
  replied: boolean;
  reply(options: {
    content: string;
    ephemeral: boolean;
  }): Promise<unknown>;
  editReply(options: {
    content: string;
  }): Promise<unknown>;
  followUp(options: {
    content: string;
    ephemeral: boolean;
  }): Promise<unknown>;
}

export async function sendDiscordText(
  channel: DiscordSendableChannel,
  content: string
): Promise<void> {
  for (const chunk of splitDiscordMessage(content)) {
    await channel.send(chunk);
  }
}

export async function sendDiscordEditableText(
  channel: DiscordSendableChannel,
  content: string
): Promise<DiscordEditableMessage | undefined> {
  const chunks = splitDiscordMessage(content);
  if (chunks.length === 0) {
    return undefined;
  }

  let editableMessage: DiscordEditableMessage | undefined;
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await channel.send(chunks[index]);
    if (index === 0 && chunks.length === 1 && isDiscordEditableMessage(result)) {
      editableMessage = result;
    }
  }

  return editableMessage;
}

export async function sendDiscordInteractionResponse(
  interaction: DiscordInteractionResponder,
  content: string,
  state?: DiscordInteractionDeliveryState
): Promise<void> {
  let initialResponseSent = state?.initialResponseSent ?? false;

  for (const chunk of splitDiscordMessage(content)) {
    if (!initialResponseSent) {
      if (interaction.replied) {
        initialResponseSent = true;
        if (state) {
          state.initialResponseSent = true;
        }
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: chunk
        });
        initialResponseSent = true;
        if (state) {
          state.initialResponseSent = true;
        }
        continue;
      } else {
        await interaction.reply({
          content: chunk,
          ephemeral: true
        });
        initialResponseSent = true;
        if (state) {
          state.initialResponseSent = true;
        }
        continue;
      }
    }

    await interaction.followUp({
      content: chunk,
      ephemeral: true
    });
    initialResponseSent = true;
    if (state) {
      state.initialResponseSent = true;
    }
  }
}

export function splitDiscordMessage(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const lines = normalized.split("\n");
  let chunkFenceHeader = "";
  let buffer = "";
  let bufferFenceHeader = "";

  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }

    chunks.push(renderDiscordChunk(buffer, chunkFenceHeader, bufferFenceHeader));
    chunkFenceHeader = bufferFenceHeader;
    buffer = "";
    bufferFenceHeader = chunkFenceHeader;
  };

  for (const line of lines) {
    let remaining = line;

    while (true) {
      const nextFenceHeader = updateFenceState(bufferFenceHeader, remaining);
      if (canAppendDiscordSegment(buffer, remaining, chunkFenceHeader, nextFenceHeader)) {
        buffer = buffer.length === 0 ? remaining : `${buffer}\n${remaining}`;
        bufferFenceHeader = nextFenceHeader;
        break;
      }

      if (buffer.length > 0) {
        flush();
        continue;
      }

      const split = splitOversizedDiscordSegment(remaining, chunkFenceHeader, bufferFenceHeader);
      buffer = split.chunk;
      bufferFenceHeader = split.nextFenceHeader;
      flush();
      remaining = split.remainder;

      if (remaining.length === 0) {
        break;
      }
    }
  }

  flush();
  return chunks;
}

function isDiscordEditableMessage(value: unknown): value is DiscordEditableMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "edit" in value &&
    typeof value.edit === "function"
  );
}

function canAppendDiscordSegment(
  buffer: string,
  segment: string,
  chunkFenceHeader: string,
  nextFenceHeader: string
): boolean {
  const candidate = buffer.length === 0 ? segment : `${buffer}\n${segment}`;
  return measureDiscordChunk(candidate, chunkFenceHeader, nextFenceHeader) <= DISCORD_MESSAGE_LIMIT;
}

function renderDiscordChunk(
  body: string,
  chunkFenceHeader: string,
  nextFenceHeader: string
): string {
  const prefix = chunkFenceHeader ? `${chunkFenceHeader}\n` : "";
  const suffix = nextFenceHeader ? "\n```" : "";
  return `${prefix}${body}${suffix}`;
}

function measureDiscordChunk(
  body: string,
  chunkFenceHeader: string,
  nextFenceHeader: string
): number {
  const prefixLength = chunkFenceHeader ? chunkFenceHeader.length + 1 : 0;
  const suffixLength = nextFenceHeader ? 4 : 0;
  return prefixLength + body.length + suffixLength;
}

function splitOversizedDiscordSegment(
  segment: string,
  chunkFenceHeader: string,
  activeFenceHeader: string
): {
  chunk: string;
  remainder: string;
  nextFenceHeader: string;
} {
  const available = Math.max(
    DISCORD_MESSAGE_LIMIT - (chunkFenceHeader ? chunkFenceHeader.length + 1 : 0) - (activeFenceHeader ? 4 : 0),
    32
  );
  const splitIndex = findPreferredDiscordSplitIndex(segment, available);

  return {
    chunk: segment.slice(0, splitIndex),
    remainder: segment.slice(splitIndex),
    nextFenceHeader: activeFenceHeader
  };
}

function findPreferredDiscordSplitIndex(segment: string, maxLength: number): number {
  if (segment.length <= maxLength) {
    return segment.length;
  }

  const minLength = Math.max(Math.floor(maxLength * 0.6), 32);
  const searchWindow = segment.slice(0, maxLength + 1);

  for (const pattern of [/\n{2,}/g, /[.!?;:]\s+/g, /,\s+/g, /\s+/g]) {
    let match: RegExpExecArray | null;
    let lastIndex = -1;

    while ((match = pattern.exec(searchWindow)) !== null) {
      const candidateIndex = match.index + match[0].length;
      if (candidateIndex >= minLength) {
        lastIndex = candidateIndex;
      }
    }

    if (lastIndex !== -1) {
      return lastIndex;
    }
  }

  return maxLength;
}

function updateFenceState(current: string, line: string): string {
  if (!line.startsWith("```")) {
    return current;
  }

  if (current) {
    return "";
  }

  return line;
}
