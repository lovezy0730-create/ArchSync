/** Serialize project work without allowing one failure to poison the queue. */
export class ProjectQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(projectId, tail);
    void tail.then(() => {
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    });
    return result;
  }

  async drain(): Promise<void> {
    await Promise.all(this.tails.values());
  }
}
