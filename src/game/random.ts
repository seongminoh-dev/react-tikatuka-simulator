export function createRng(seed: number): () => number {
  let value = seed >>> 0;

  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rollDie(rng: () => number): 1 | 2 | 3 | 4 | 5 | 6 {
  return (Math.floor(rng() * 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

export function rollDifferentDie(
  rng: () => number,
  excluded: 1 | 2 | 3 | 4 | 5 | 6
): 1 | 2 | 3 | 4 | 5 | 6 {
  const rolled = (Math.floor(rng() * 5) + 1) as 1 | 2 | 3 | 4 | 5;
  return (rolled >= excluded ? rolled + 1 : rolled) as 1 | 2 | 3 | 4 | 5 | 6;
}
