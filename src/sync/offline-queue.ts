export interface QueuedOperation {
  id: string;
  type: "push" | "delete-remote";
  relativePath: string;
  contentHash: string;
  queuedAt: string;
}

export class OfflineQueue {
  private operations: QueuedOperation[] = [];

  load(data: QueuedOperation[]): void {
    this.operations = data || [];
  }

  toJSON(): QueuedOperation[] {
    return this.operations;
  }

  enqueue(op: Omit<QueuedOperation, "id" | "queuedAt">): void {
    // Remove any existing operation for the same path
    this.operations = this.operations.filter(
      (o) => o.relativePath !== op.relativePath
    );
    this.operations.push({
      ...op,
      id: crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
    });
  }

  drain(): QueuedOperation[] {
    const ops = [...this.operations];
    this.operations = [];
    return ops;
  }

  get length(): number {
    return this.operations.length;
  }

  get isEmpty(): boolean {
    return this.operations.length === 0;
  }
}
