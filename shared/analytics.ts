export const usageEvents = ["play", "remix_created", "share_created", "share_copied", "shared_open", "engagement"] as const;
export type UsageEvent = typeof usageEvents[number];
export type UsageAction = Exclude<UsageEvent, "engagement">;
export type UsageCount = { name: UsageEvent; count: number; first: 0 | 1 };
export type UsageBatch = { version: 1; events: UsageCount[] };

export function validUsageBatch(value: unknown): value is UsageBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const batch = value as Record<string, unknown>;
  if (Object.keys(batch).sort().join() !== "events,version" || batch.version !== 1 ||
      !Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > usageEvents.length) return false;
  const names = new Set<string>();
  return batch.events.every((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const event = item as Record<string, unknown>;
    if (Object.keys(event).sort().join() !== "count,first,name" ||
        !usageEvents.includes(event.name as UsageEvent) || names.has(event.name as string) ||
        !Number.isInteger(event.count) || (event.count as number) < (event.name === "engagement" ? 0 : 1) ||
        (event.count as number) > (event.name === "engagement" ? 300 : 100) ||
        (event.first !== 0 && event.first !== 1)) return false;
    names.add(event.name as string);
    return true;
  });
}
