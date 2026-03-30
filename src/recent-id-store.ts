import { promises as fs } from "node:fs";
import path from "node:path";

interface RecentIdStoreFile {
  entries?: Array<{
    id?: string;
    seenAt?: number;
  }>;
}

export function deriveRecentIdStorePath(
  sessionStorePath: string,
  namespace: string
): string {
  return path.join(path.dirname(sessionStorePath), `${namespace}-recent-ids.json`);
}

export class FileRecentIdStore {
  private entries = new Map<string, number>();
  private loaded = false;
  private pending = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number
  ) {}

  async rememberIfNew(id: string | undefined): Promise<boolean> {
    if (!id) {
      return false;
    }

    return this.runExclusive(async () => {
      await this.load();

      const now = Date.now();
      this.prune(now);

      if (this.entries.has(id)) {
        return true;
      }

      this.entries.set(id, now);
      await this.writeFile();
      return false;
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loaded = true;

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as RecentIdStoreFile;
      for (const entry of parsed.entries ?? []) {
        const seenAt = entry.seenAt;
        if (typeof entry.id === "string" && typeof seenAt === "number" && Number.isFinite(seenAt)) {
          this.entries.set(entry.id, seenAt);
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }
  }

  private prune(now: number): void {
    for (const [id, seenAt] of this.entries.entries()) {
      if (now - seenAt > this.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  private async writeFile(): Promise<void> {
    const payload: RecentIdStoreFile = {
      entries: [...this.entries.entries()].map(([id, seenAt]) => ({
        id,
        seenAt
      }))
    };
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
    await fs.rename(tempPath, this.filePath);
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task);
    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
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
