export class SerialTurnQueue {
  private readonly tails = new Map<string, Promise<void>>();

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const currentTail = previous
      .catch(() => undefined)
      .then(() => gate);

    this.tails.set(key, currentTail);

    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === currentTail) {
        this.tails.delete(key);
      }
    }
  }
}
