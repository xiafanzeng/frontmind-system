export function uniquifyOrderedIds<T extends { id: string }>(
  items: readonly T[],
  maxLength = 128,
): T[] {
  const used = new Set<string>();
  const nextOrdinal = new Map<string, number>();

  return items.map((item) => {
    const original = item.id;
    if (!used.has(original)) {
      used.add(original);
      nextOrdinal.set(original, 2);
      return item;
    }

    let ordinal = nextOrdinal.get(original) ?? 2;
    let candidate = "";
    do {
      const suffix = `~${ordinal}`;
      candidate = `${original.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
      ordinal += 1;
    } while (used.has(candidate));

    used.add(candidate);
    nextOrdinal.set(original, ordinal);
    return { ...item, id: candidate };
  });
}
