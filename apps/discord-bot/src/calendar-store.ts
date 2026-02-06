export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  notes?: string;
}

export interface CalendarUpdateInput {
  title: string;
  startsAt: string;
  notes?: string;
}

export class InMemoryCalendarStore {
  private readonly events = new Map<string, CalendarEvent>();

  update(input: CalendarUpdateInput): CalendarEvent {
    const id = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const event: CalendarEvent = {
      id,
      title: input.title,
      startsAt: input.startsAt,
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.events.set(id, event);
    return event;
  }

  list(): CalendarEvent[] {
    return [...this.events.values()];
  }
}
