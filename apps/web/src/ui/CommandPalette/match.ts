export function matchScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;

  let score = 0;
  let position = 0;
  let previousWasHit = false;
  for (const char of q) {
    const index = t.indexOf(char, position);
    if (index < 0) return null;
    const wordStart = index === 0 || /[\s\-_./:]/.test(t[index - 1] ?? '');
    if (wordStart) score += 10;
    if (previousWasHit && index === position) score += 5;
    previousWasHit = index === position;
    position = index + 1;
  }
  return score - (position - q.length) - t.length / 100;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

export function rank<T>(items: T[], query: string, text: (item: T) => string): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const score = matchScore(query, text(item));
    if (score !== null) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
