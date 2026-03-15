import { promises as fs } from "node:fs";
import path from "node:path";

import type { ConversationBinding, ConversationKey } from "./domain.js";
import { conversationKeyToId } from "./domain.js";

interface SessionStoreFile {
  bindings: ConversationBinding[];
}

export interface SessionStore {
  get(key: ConversationKey): Promise<ConversationBinding | undefined>;
  upsert(binding: ConversationBinding): Promise<void>;
  delete(key: ConversationKey): Promise<void>;
  list(): Promise<ConversationBinding[]>;
}

export class FileSessionStore implements SessionStore {
  private readonly bindings = new Map<string, ConversationBinding>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async get(key: ConversationKey): Promise<ConversationBinding | undefined> {
    await this.ensureLoaded();
    return this.bindings.get(conversationKeyToId(key));
  }

  async upsert(binding: ConversationBinding): Promise<void> {
    await this.ensureLoaded();
    this.bindings.set(conversationKeyToId(binding.key), binding);
    await this.flush();
  }

  async delete(key: ConversationKey): Promise<void> {
    await this.ensureLoaded();
    this.bindings.delete(conversationKeyToId(key));
    await this.flush();
  }

  async list(): Promise<ConversationBinding[]> {
    await this.ensureLoaded();
    return [...this.bindings.values()];
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionStoreFile;
      for (const binding of parsed.bindings ?? []) {
        this.bindings.set(conversationKeyToId(binding.key), binding);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    const payload: SessionStoreFile = {
      bindings: [...this.bindings.values()]
    };

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

