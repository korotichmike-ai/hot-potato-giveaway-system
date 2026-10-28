// Hot Potato Arena: round pacing (plan section 3). Shared by the overlay and the Worker,
// so the server knows when the animation ends and the claim timer starts.

const NORMAL = { intro: 1.5, firstGap: 0.6, lateGap: 0.85, finalGap: 1.6, minHitGap: 0.25, maxFastGap: 0.4, floor: 10 };
// Rerolls replay a short version (~5 s).
const SHORT = { intro: 0.8, firstGap: 0.4, lateGap: 0.45, finalGap: 0.9, minHitGap: 0.25, maxFastGap: 0.3, floor: 0 };

// Returns { intro, hits: [{ kind: 'fast'|'late'|'final', count, t }], total } with times in seconds.
// Fast hits can knock out several balls in a chain when there are too many entrants for the budget.
export function buildSchedule(n, { short = false } = {}) {
  const p = short ? SHORT : NORMAL;
  if (n < 2) return { intro: p.intro, hits: [], total: n === 1 ? 0.6 : 0, fastCount: 0, fastHits: 0, lateCount: 0, short };
  const fastCount = Math.max(0, n - 6), lateCount = Math.min(4, n - 2);
  const target = short ? 5 : n <= 40 ? 15 : Math.min(19, 15 + (n - 40) * 4 / 110);
  let { lateGap, finalGap } = p;
  let fastGap = 0, fastHits = 0;
  if (fastCount) {
    const budget = Math.max(short ? 0.6 : 1, target - p.intro - p.firstGap - lateCount * lateGap - finalGap);
    fastHits = Math.min(fastCount, Math.max(1, Math.floor(budget / p.minHitGap)));
    fastGap = Math.min(p.maxFastGap, budget / fastHits);
  }
  const hits = [];
  for (let i = 0; i < fastHits; i++) hits.push({ kind: 'fast', count: Math.floor(fastCount * (i + 1) / fastHits) - Math.floor(fastCount * i / fastHits) });
  for (let i = 0; i < lateCount; i++) hits.push({ kind: 'late', count: 1 });
  hits.push({ kind: 'final', count: 1 });
  const calc = () => {
    let t = p.intro;
    return hits.map((h, i) => {
      const g = h.kind === 'fast' ? fastGap : h.kind === 'late' ? lateGap : finalGap;
      t += i === 0 ? Math.max(g, p.firstGap) : g;
      return t;
    });
  };
  let times = calc();
  // Small rounds: stretch the late phase and final chase toward the 10 s floor.
  for (let k = 0; k < 60 && times[times.length - 1] < p.floor; k++) {
    lateGap = Math.min(1.4, lateGap + 0.03);
    finalGap = Math.min(2.6, finalGap + 0.05);
    if (fastGap) fastGap = Math.min(0.55, fastGap + 0.01);
    times = calc();
  }
  hits.forEach((h, i) => { h.t = times[i]; });
  return { intro: p.intro, hits, total: times[times.length - 1], fastCount, fastHits, fastGap, lateCount, lateGap, finalGap, short };
}

// Seconds from the end of the animation until the winner card appears.
export const CARD_DELAY = 0.9;

// Milliseconds from launch until the winner card is on screen (the claim timer starts here).
export function roundMs(n, opts) {
  if (n === 0) return 0;
  return Math.ceil((buildSchedule(n, opts).total + (n === 1 ? 0.3 : CARD_DELAY)) * 1000);
}
