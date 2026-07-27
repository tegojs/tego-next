export interface SettledCapabilityEntry {
  settled: boolean;
}

export function getCapabilityEntry<T extends SettledCapabilityEntry>(
  entries: Map<string, T>,
  key: string,
): T | undefined {
  const entry = entries.get(key);
  if (entry?.settled === true) {
    entries.delete(key);
    entries.set(key, entry);
  }
  return entry;
}

export function reserveCapabilityEntry<T extends SettledCapabilityEntry>(
  entries: Map<string, T>,
  maximum: number,
): boolean {
  while (entries.size >= maximum) {
    const leastRecentlyUsed = [...entries].find(([, entry]) => entry.settled);
    if (leastRecentlyUsed === undefined) return false;
    entries.delete(leastRecentlyUsed[0]);
  }
  return true;
}

export function countPendingCapabilityEntries<T extends SettledCapabilityEntry>(
  entries: ReadonlyMap<string, T>,
): number {
  let pending = 0;
  for (const entry of entries.values()) {
    if (!entry.settled) pending += 1;
  }
  return pending;
}
