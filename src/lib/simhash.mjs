// 64-bit SimHash (Charikar) — a near-duplicate fingerprint for text. Pure JS, no
// dependencies. Two documents that differ only in boilerplate/template produce
// fingerprints a small Hamming distance apart; genuinely different documents are far
// apart. Used (opt-in) to collapse near-duplicate pages the exact-hash dedup misses.
//
// Why a fingerprint and not a full diff: it is O(1) to compare (one XOR + popcount over
// 64 bits) and O(tokens) to build, so a whole crawl can be de-duped cheaply. Evidence:
// Manku/Google "Detecting Near-Duplicates for Web Crawling"; Charikar SimHash.
//
// A fingerprint is `{ hi, lo }` — two unsigned 32-bit halves of the 64-bit value — so the
// hot path (build + Hamming) stays on fast 32-bit integer math, never BigInt.

/** MurmurHash3-style 32-bit hash over a string's UTF-16 code units. Good bit mixing (the
 *  finalizer avalanches), deterministic, fast — ample for fingerprint features. */
function murmur3_32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    let k = Math.imul(str.charCodeAt(i), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= str.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 64-bit hash of a feature, as two independent 32-bit halves. */
function hash64(str) {
  return { hi: murmur3_32(str, 0x9747b28c), lo: murmur3_32(str, 0x01000193) };
}

/** Lowercased alphanumeric tokens (length ≥ 2). */
function tokenize(text) {
  const out = [];
  for (const t of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 2) out.push(t);
  }
  return out;
}

/**
 * Weighted features for the fingerprint: word SHINGLES (n-grams) counted by frequency.
 * Shingles (default bigrams) localise a change to a couple of features, so a small edit
 * flips only a few fingerprint bits — the property near-dup detection relies on. Falls
 * back to unigrams for very short texts.
 */
function features(text, shingle) {
  const toks = tokenize(text);
  const map = new Map();
  const n = Math.max(1, shingle);
  if (toks.length < n) {
    for (const t of toks) map.set(t, (map.get(t) || 0) + 1);
  } else {
    for (let i = 0; i + n <= toks.length; i++) {
      const key = toks.slice(i, i + n).join(' ');
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return map;
}

/**
 * Compute the 64-bit SimHash of `text`.
 * @param {string} text
 * @param {{ shingle?: number }} [opts]  n-gram size for features (default 2)
 * @returns {{ hi: number, lo: number }}  the fingerprint (two unsigned 32-bit halves)
 */
export function simhash(text, { shingle = 2 } = {}) {
  const feats = features(text, shingle);
  const v = new Array(64).fill(0); // per-bit weighted vote
  for (const [feat, w] of feats) {
    const { hi, lo } = hash64(feat);
    for (let i = 0; i < 32; i++) {
      v[i] += (lo >>> i) & 1 ? w : -w;
      v[i + 32] += (hi >>> i) & 1 ? w : -w;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 32; i++) {
    if (v[i] > 0) lo |= 1 << i;
    if (v[i + 32] > 0) hi |= 1 << i;
  }
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

/** Count set bits in a 32-bit integer (SWAR popcount). */
function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24);
}

/** Hamming distance (0..64) between two fingerprints. */
export function hamming(a, b) {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

/** True when two fingerprints are within `maxHamming` bits — i.e. near-duplicates. */
export function isNearDup(a, b, maxHamming) {
  return hamming(a, b) <= maxHamming;
}
