const STOPWORDS = new Set(
  ("a an and are as at be by for from has how i in is it of on or the to vs what why with you your my we our" +
    " 101 diy").split(" "),
);

/**
 * Seed fingerprint: the recurring terms in a channel's recent upload titles.
 * Deliberately simple — term frequency over tokenized titles, stopwords out.
 */
export function fingerprintFromTitles(titles: string[], top = 6): string[] {
  const freq = new Map<string, number>();
  for (const title of titles) {
    for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || STOPWORDS.has(raw)) continue;
      freq.set(raw, (freq.get(raw) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([term]) => term);
}
