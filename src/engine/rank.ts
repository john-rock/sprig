// Matching and ordering of candidate suggestions against the typed word.

/** Higher is better; undefined means no match. */
export function matchScore(name: string, term: string): number | undefined {
  if (term === "") return 0;
  if (name.startsWith(term)) return 4;
  const n = name.toLowerCase();
  const t = term.toLowerCase();
  if (n.startsWith(t)) return 3;
  if (t.length < 2) return undefined;
  if (n.includes(t)) return 2;
  // Fuzzy (typo tolerance): same first letter, then all chars in order.
  const lead = (s: string) => s.replace(/^[-$+]+/, "")[0];
  if (lead(n) !== lead(t)) return undefined;
  let i = 0;
  for (const c of n) if (c === t[i]) i++;
  return i === t.length ? 1 : undefined;
}

export type Ranked<T> = { item: T; score: number };

export function rank<T>(
  items: T[],
  getNames: (item: T) => string[],
  getTerm: (item: T) => string,
  getPriority: (item: T) => number,
  getBoost: (item: T) => number = () => 0,
): T[] {
  const ranked: (Ranked<T> & { order: number; priority: number })[] = [];
  items.forEach((item, order) => {
    const term = getTerm(item);
    let best: number | undefined;
    for (const name of getNames(item)) {
      const s = matchScore(name, term);
      if (s !== undefined && (best === undefined || s > best)) best = s;
    }
    if (best !== undefined) ranked.push({ item, score: best, order, priority: getPriority(item) + getBoost(item) });
  });
  // Substring / fuzzy matches are a fallback for typos, not noise next to real prefix hits.
  const PREFIX = 3;
  const kept = ranked.some((r) => r.score >= PREFIX) ? ranked.filter((r) => r.score >= PREFIX) : ranked;
  kept.sort((a, b) => b.score - a.score || b.priority - a.priority || a.order - b.order);
  return kept.map((r) => r.item);
}
