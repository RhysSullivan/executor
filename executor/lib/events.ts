export interface LiveTaskEvent {
  id: number;
  eventName: string;
  payload: unknown;
  createdAt: number;
}

type Subscriber = (event: LiveTaskEvent) => void;

export class TaskEventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  publish(taskId: string, event: LiveTaskEvent): void {
    const listeners = this.subscribers.get(taskId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }

    if (listeners.size === 0) {
      this.subscribers.delete(taskId);
    }
  }

  subscribe(taskId: string, listener: Subscriber): () => void {
    const listeners = this.subscribers.get(taskId) ?? new Set<Subscriber>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);

    return () => {
      const active = this.subscribers.get(taskId);
      if (!active) {
        return;
      }

      active.delete(listener);
      if (active.size === 0) {
        this.subscribers.delete(taskId);
      }
    };
  }
}
