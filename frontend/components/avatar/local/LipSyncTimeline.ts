import type { WordBoundary, PhonemeBoundary } from "../../../services/interviewApi";
import { normalizeBoundaryToken } from "./TextNormalizer.ts";

export const VISEMES = [
  "mbp",
  "aa",
  "ae",
  "ee",
  "oh",
  "oo",
  "fv",
  "sh",
  "ldt",
  "th",
  "kg",
  "sz",
  "r",
] as const;
export type LocalViseme = (typeof VISEMES)[number];

export type VisemeEvent = {
  start: number;
  end: number;
  viseme: LocalViseme;
};

// Perceptual priority: higher = preserve when time is tight.
// Tier 1 (10): vowels & bilabial closures (mbp, aa, ae, ee, oh, oo)
// Tier 2 (9):  distinctive labiodentals & linguadentals (fv, th)
// Tier 3 (7):  sibilants & rhotics (sh, sz, r)
// Tier 4 (4):  transient stops (ldt, kg)
const VISEME_PRIORITY: Record<LocalViseme, number> = {
  mbp: 10,
  aa: 10, ae: 10, ee: 10, oh: 10, oo: 10,
  fv: 9, th: 9,
  sh: 7, sz: 7, r: 7,
  ldt: 4, kg: 4,
};

// Minimum display time (seconds) that stabilizeVisemeTimeline will try to reach.
const VISEME_MIN_DWELL_S: Record<LocalViseme, number> = {
  aa: 0.085, ae: 0.080, ee: 0.085, oh: 0.085, oo: 0.085,
  fv: 0.060, sh: 0.060, th: 0.060, sz: 0.055,
  r: 0.060,
  mbp: 0.055,
  kg: 0.050,
  ldt: 0.050,
};

// Precise phoneme-to-viseme mapping for 13 distinct visual poses:
// m, b, p   → bilabial closures → mbp
// g, k, q   → velars: relaxed open jaw, retracted tongue → kg
// x         → alveolar fricative blend → sz
// h         → glottal/velar opening → kg
// f, v      → labiodental: teeth on lower lip → fv
// th        → linguadental: tongue between teeth → th
// s, z      → alveolar fricatives: closed teeth → sz
// l, d, t, n → alveolar tongue-tip contact → ldt
// sh, ch, zh, j → postalveolar projected lips → sh
// r         → retroflex mild rounding → r
// a, ah     → open vertical jaw → aa
// ae, eh    → medium-open wide front vowels → ae
// e, i, y   → close spread front vowels → ee
// o, oh     → rounded open oval → oh
// u, oo, w  → tightly rounded pucker → oo
const PHONEME_TO_VISEME: Record<string, LocalViseme> = {
  m: "mbp", b: "mbp", p: "mbp", mbp: "mbp",
  g: "kg",  k: "kg",  q: "kg",  ng: "kg", kg: "kg",
  x: "sz",  h: "kg",
  f: "fv",  v: "fv",  fv: "fv",
  th: "th",
  s: "sz",  z: "sz",  sz: "sz",
  l: "ldt", d: "ldt", t: "ldt", n: "ldt", ldt: "ldt",
  sh: "sh", ch: "sh", zh: "sh", j: "sh",
  r: "r",
  a: "aa",  ah: "aa", aa: "aa",
  ae: "ae", eh: "ae",
  e: "ee",  i: "ee",  y: "ee", ee: "ee",
  o: "oh",  oh: "oh",
  u: "oo",  oo: "oo", ow: "oo", w: "oo",
};

// Pronunciation hints for numbers, ordinals, symbols, technical terms, letter syllables, and irregular words.
const TECHNICAL_PRONUNCIATIONS: Record<string, string[]> = {
  // Numbers
  zero: ["sz", "ee", "r", "oh"],
  one: ["u", "a", "n"],
  two: ["t", "u"],
  three: ["th", "r", "e"],
  four: ["f", "o", "r"],
  five: ["f", "a", "e", "v"],
  six: ["s", "e", "k", "s"],
  seven: ["s", "eh", "v", "a", "n"],
  eight: ["eh", "e", "t"],
  nine: ["n", "a", "e", "n"],
  ten: ["t", "eh", "n"],
  eleven: ["e", "l", "eh", "v", "a", "n"],
  twelve: ["t", "w", "eh", "l", "v"],
  thirteen: ["th", "r", "t", "e", "n"],
  fourteen: ["f", "o", "r", "t", "e", "n"],
  fifteen: ["f", "e", "f", "t", "e", "n"],
  sixteen: ["s", "e", "k", "s", "t", "e", "n"],
  seventeen: ["s", "eh", "v", "a", "n", "t", "e", "n"],
  eighteen: ["eh", "t", "e", "n"],
  nineteen: ["n", "a", "e", "n", "t", "e", "n"],
  twenty: ["t", "w", "eh", "n", "t", "e"],
  thirty: ["th", "r", "t", "e"],
  forty: ["f", "o", "r", "t", "e"],
  fifty: ["f", "e", "f", "t", "e"],
  sixty: ["s", "e", "k", "s", "t", "e"],
  seventy: ["s", "eh", "v", "a", "n", "t", "e"],
  eighty: ["eh", "t", "e"],
  ninety: ["n", "a", "e", "n", "t", "e"],
  hundred: ["h", "a", "n", "d", "r", "eh", "d"],
  thousand: ["th", "a", "u", "z", "a", "n", "d"],
  million: ["m", "e", "l", "y", "a", "n"],
  billion: ["b", "e", "l", "y", "a", "n"],

  // Ordinals
  first: ["f", "r", "s", "t"],
  second: ["s", "eh", "k", "a", "n", "d"],
  third: ["th", "r", "d"],
  fourth: ["f", "o", "r", "th"],
  fifth: ["f", "e", "f", "th"],
  sixth: ["s", "e", "k", "s", "th"],
  seventh: ["s", "eh", "v", "a", "n", "th"],
  eighth: ["eh", "t", "th"],
  ninth: ["n", "a", "e", "n", "th"],
  tenth: ["t", "eh", "n", "th"],
  twentieth: ["t", "w", "eh", "n", "t", "e", "eh", "th"],
  hundredth: ["h", "a", "n", "d", "r", "eh", "d", "th"],

  // Units, symbols & math
  percent: ["p", "r", "s", "eh", "n", "t"],
  dollar: ["d", "a", "l", "r"],
  dollars: ["d", "a", "l", "r", "z"],
  cent: ["s", "eh", "n", "t"],
  cents: ["s", "eh", "n", "t", "s"],
  point: ["p", "o", "e", "n", "t"],
  negative: ["n", "eh", "g", "a", "t", "e", "v"],
  plus: ["p", "l", "a", "s"],
  equals: ["e", "k", "w", "a", "l", "z"],
  number: ["n", "a", "m", "b", "r"],

  // Letter syllables for spoken initialisms (API, HTTP, HTML, CSS, LLM, GPT, JWT, etc.)
  ay: ["ae"],
  bee: ["b", "e"],
  see: ["s", "e"],
  dee: ["d", "e"],
  ee: ["e"],
  eff: ["eh", "f"],
  gee: ["j", "e"],
  jee: ["j", "e"],
  aitch: ["ae", "ch"],
  eye: ["a", "e"],
  jay: ["j", "ae"],
  kay: ["k", "ae"],
  el: ["eh", "l"],
  em: ["eh", "m"],
  en: ["eh", "n"],
  oh: ["oh"],
  pee: ["p", "e"],
  cue: ["k", "y", "u"],
  queue: ["k", "y", "u"],
  are: ["a", "r"],
  ess: ["eh", "s"],
  tee: ["t", "e"],
  you: ["y", "u"],
  vee: ["v", "e"],
  double: ["d", "a", "b", "l"],
  ex: ["eh", "k", "s"],
  why: ["w", "a", "e"],
  zee: ["z", "e"],
  zed: ["z", "eh", "d"],

  // Benchmark common & interview words
  think: ["th", "e", "ng", "k"],
  this: ["th", "e", "s"],
  there: ["th", "eh", "r"],
  the: ["th", "a"],
  hello: ["h", "eh", "l", "oh"],
  world: ["w", "r", "l", "d"],
  interview: ["e", "n", "t", "r", "v", "y", "u"],
  interviewer: ["e", "n", "t", "r", "v", "y", "u", "r"],
  technical: ["t", "eh", "k", "n", "e", "k", "a", "l"],
  question: ["k", "w", "eh", "s", "ch", "a", "n"],
  questions: ["k", "w", "eh", "s", "ch", "a", "n", "z"],
  higher: ["h", "a", "e", "r"],
  price: ["p", "r", "a", "e", "s"],
  score: ["s", "k", "o", "r"],
  data: ["d", "ae", "t", "ae"],
  sends: ["s", "eh", "n", "d", "z"],
  works: ["w", "r", "k", "s"],
  code: ["k", "o", "d"],
  user: ["y", "u", "z", "r"],
  users: ["y", "u", "z", "r", "z"],
  contains: ["k", "a", "n", "t", "ae", "n", "z"],
  receives: ["r", "e", "s", "e", "v", "z"],
  received: ["r", "e", "s", "e", "v", "d"],
  query: ["k", "w", "e", "r", "e"],
  queries: ["k", "w", "e", "r", "e", "z"],
  token: ["t", "oh", "k", "a", "n"],
  tokens: ["t", "oh", "k", "a", "n", "z"],
  pipeline: ["p", "a", "e", "p", "l", "a", "e", "n"],
  pipelines: ["p", "a", "e", "p", "l", "a", "e", "n", "z"],
  architecture: ["aa", "r", "k", "e", "t", "eh", "k", "ch", "r"],
  relational: ["r", "e", "l", "ae", "sh", "a", "n", "a", "l"],
  released: ["r", "e", "l", "e", "s", "t"],
  release: ["r", "e", "l", "e", "s"],
  explain: ["e", "k", "s", "p", "l", "ae", "n"],
  quickly: ["k", "w", "e", "k", "l", "e"],
  what: ["w", "a", "t"],
  between: ["b", "e", "t", "w", "e", "n"],
  per: ["p", "r"],
  version: ["v", "eh", "r", "sh", "a", "n"],
  through: ["th", "r", "u"],

  // Technical terms & compounds
  python: ["p", "i", "th", "a", "n"],
  api: ["ae", "p", "e"],
  sql: ["s", "e", "k", "w", "e", "l"],
  sequel: ["s", "e", "k", "w", "e", "l"],
  json: ["j", "ae", "s", "a", "n"],
  rest: ["r", "eh", "s", "t"],
  fast: ["f", "ae", "s", "t"],
  postgres: ["p", "oh", "s", "t", "g", "r", "eh", "s"],
  docker: ["d", "aa", "k", "r"],
  kubernetes: ["k", "u", "b", "r", "n", "eh", "t", "e", "z"],
  redis: ["r", "eh", "d", "e", "s"],
  kafka: ["k", "aa", "f", "k", "aa"],
  github: ["g", "e", "t", "h", "a", "b"],
  git: ["g", "e", "t"],
  linux: ["l", "e", "n", "u", "k", "s"],
  ubuntu: ["u", "b", "u", "n", "t", "u"],
  async: ["ae", "s", "e", "n", "k"],
  await: ["ae", "w", "ae", "t"],
  asyncio: ["ae", "s", "e", "n", "k", "e", "o"],
  decorator: ["d", "eh", "k", "ae", "r", "ae", "t", "r"],
  iterator: ["e", "t", "ae", "r", "ae", "t", "r"],
  generator: ["j", "eh", "n", "ae", "r", "ae", "t", "r"],
  polymorphism: ["p", "aa", "l", "e", "m", "o", "r", "f", "e", "z", "a", "m"],
  encapsulation: ["eh", "n", "k", "ae", "p", "s", "u", "l", "ae", "sh", "a", "n"],
  inheritance: ["e", "n", "h", "eh", "r", "e", "t", "a", "n", "s"],
  numpy: ["n", "u", "m", "p", "e"],
  pandas: ["p", "ae", "n", "d", "a", "s"],
  django: ["j", "ae", "ng", "g", "o"],
  fastapi: ["f", "ae", "s", "t", "ae", "p", "e"],
  pytest: ["p", "i", "t", "eh", "s", "t"],
  orm: ["o", "r", "m"],
  http: ["ae", "ch", "t", "e", "t", "e", "p", "e"],
  tuple: ["t", "u", "p", "l"],
  database: ["d", "ae", "t", "a", "b", "ae", "s"],
  transaction: ["t", "r", "ae", "n", "z", "ae", "k", "sh", "a", "n"],
  difference: ["d", "e", "f", "r", "a", "n", "s"],
};

export function normalizeBoundaryText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type PhonemeResolution = {
  phonemes: string[];
  source: "dictionary" | "heuristic" | "fallback";
};

/**
 * Rule-based Grapheme-to-Phoneme engine for unlisted English words.
 * Handles silent letters (kn-, wr-, -mb, ght), vowel digraphs (ee, ea, oo, ou, ai, oa, oi),
 * endings (-tion, -sion, -ture, -ing, -ed, -es), and phonological c/q/x mappings.
 */
export function ruleBasedG2P(word: string): string[] {
  const clean = normalizeBoundaryText(word);
  if (!clean) return [];

  const result: string[] = [];
  let i = 0;

  // Prefix silent letters
  if (clean.startsWith("kn") || clean.startsWith("gn")) {
    result.push("n");
    i = 2;
  } else if (clean.startsWith("wr")) {
    result.push("r");
    i = 2;
  } else if (clean.startsWith("wh")) {
    result.push("w");
    i = 2;
  }

  while (i < clean.length) {
    const rem = clean.slice(i);
    // Suffix handling
    if (rem === "tion" || rem === "sion") {
      result.push("sh", "a", "n");
      break;
    }
    if (rem === "ture" || rem === "sure") {
      result.push("sh", "r");
      break;
    }
    if (rem === "ing" && i > 1) {
      result.push("e", "ng");
      break;
    }

    const c = clean[i];
    const pair = clean.slice(i, i + 2);
    const tri = clean.slice(i, i + 3);

    // Tri-graphs
    if (tri === "ght") {
      result.push("t");
      i += 3;
      continue;
    }

    // Consonant digraphs
    if (["th", "sh", "ch", "zh", "ng", "ph"].includes(pair)) {
      result.push(pair === "ph" ? "f" : pair);
      i += 2;
      continue;
    }
    if (pair === "ck") {
      result.push("k");
      i += 2;
      continue;
    }
    if (pair === "gh") {
      if (i === clean.length - 2) result.push("f");
      i += 2;
      continue;
    }

    // Vowel digraphs
    if (["ee", "ea", "ie", "ei"].includes(pair)) {
      result.push("e");
      i += 2;
      continue;
    }
    if (["ai", "ay"].includes(pair)) {
      result.push("ae");
      i += 2;
      continue;
    }
    if (pair === "oa") {
      result.push("o");
      i += 2;
      continue;
    }
    if (pair === "oo") {
      result.push("u");
      i += 2;
      continue;
    }
    if (pair === "ou" || pair === "ow") {
      result.push("u");
      i += 2;
      continue;
    }
    if (pair === "oi" || pair === "oy") {
      result.push("o", "e");
      i += 2;
      continue;
    }

    // Phonological single consonants
    if (c === "c") {
      const nextC = clean[i + 1];
      if (["e", "i", "y"].includes(nextC)) {
        result.push("s");
      } else {
        result.push("k");
      }
      i += 1;
      continue;
    }
    if (c === "q") {
      result.push("k", "w");
      if (clean[i + 1] === "u") i += 1;
      i += 1;
      continue;
    }
    if (c === "x") {
      result.push("k", "s");
      i += 1;
      continue;
    }

    // Silent trailing 'e' (magic-e in VCe)
    if (c === "e" && i === clean.length - 1 && clean.length > 2) {
      i += 1;
      continue;
    }

    // Terminal silent 'b' after 'm' (climb, thumb)
    if (c === "b" && i === clean.length - 1 && clean[i - 1] === "m") {
      i += 1;
      continue;
    }

    // Vowels
    if (c === "a") result.push("ae");
    else if (c === "e") result.push("eh");
    else if (c === "i" || c === "y") result.push("e");
    else if (c === "o") result.push("o");
    else if (c === "u") result.push("u");
    else if (/[a-z]/.test(c)) result.push(c);

    i += 1;
  }

  return result;
}

export function resolveWordPhonemes(value: string): PhonemeResolution {
  const clean = normalizeBoundaryText(value);
  if (!clean) {
    return { phonemes: [], source: "fallback" };
  }
  const override = TECHNICAL_PRONUNCIATIONS[clean];
  if (override) {
    return { phonemes: override, source: "dictionary" };
  }
  const g2p = ruleBasedG2P(clean);
  if (g2p.length > 0) {
    return { phonemes: g2p, source: "heuristic" };
  }
  return { phonemes: ["eh"], source: "fallback" };
}

export function approximatePhonemes(value: string): string[] {
  return resolveWordPhonemes(value).phonemes;
}

/**
 * Visual importance tiers for dominance-based reduction:
 * Tier 1 (10): mbp, aa, ae, ee, oh, oo (vowels & bilabial closures)
 * Tier 2 (9):  fv, th (labiodental & linguadental)
 * Tier 3 (7):  sh, sz, r (sibilants & rhotics)
 * Tier 4 (4):  ldt, kg (transient alveolar & velar stops)
 */
export const VISEME_IMPORTANCE: Record<LocalViseme, number> = {
  mbp: 10,
  aa:  10,
  ae:  10,
  ee:  10,
  oh:  10,
  oo:  10,
  fv:  9,
  th:  9,
  sh:  7,
  sz:  7,
  r:   7,
  ldt: 4,
  kg:  4,
};

/**
 * Syllable-aware articulatory duration model.
 * Allocates primary duration to syllable vowel nuclei (2.4–3.2 weight),
 * preserves bilabials (mbp) and labials (fv, th), keeps onsets/codas concise,
 * and dynamically adapts to word duration (Fast <180ms, Medium, Slow >450ms).
 *
 * Guarantees ZERO accumulated timing drift: sum(durations) === wordDurationSec.
 */
export function computeSyllableAwareDurations(
  phonemes: string[],
  wordDurationSec: number,
): number[] {
  const n = phonemes.length;
  if (n === 0) return [];
  if (n === 1) return [wordDurationSec];

  const visemes = phonemes.map((p) => PHONEME_TO_VISEME[p] ?? "ldt");
  const isVowel = visemes.map((v) => v === "aa" || v === "ae" || v === "ee" || v === "oh" || v === "oo");

  // Word duration adaptation
  let onsetWeight = 1.0;
  let nucleusWeight = 2.8;
  let codaWeight = 1.1;

  if (wordDurationSec < 0.180) {
    // Fast word (<180ms): vowel nucleus strongly emphasized
    onsetWeight = 0.85;
    nucleusWeight = 3.2;
    codaWeight = 0.9;
  } else if (wordDurationSec > 0.450) {
    // Slow word (>450ms): allow full articulation sequence
    onsetWeight = 1.2;
    nucleusWeight = 2.4;
    codaWeight = 1.2;
  }

  let hasSeenVowel = false;
  const weights: number[] = [];
  for (let i = 0; i < n; i += 1) {
    if (isVowel[i]) {
      hasSeenVowel = true;
      weights.push(nucleusWeight);
    } else {
      const v = visemes[i];
      // Distinctive articulatory closures (mbp, fv, th) receive a visibility boost
      const distinctiveness = (v === "mbp" || v === "fv" || v === "th") ? 1.3 : 1.0;
      if (!hasSeenVowel) {
        weights.push(onsetWeight * distinctiveness);
      } else {
        weights.push(codaWeight * distinctiveness);
      }
    }
  }

  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;
  const durations: number[] = [];
  let allocated = 0;
  for (let i = 0; i < n; i += 1) {
    if (i === n - 1) {
      durations.push(Math.max(0.005, wordDurationSec - allocated));
    } else {
      const d = (weights[i] / totalWeight) * wordDurationSec;
      durations.push(d);
      allocated += d;
    }
  }
  return durations;
}

export function buildVisemeTimeline(
  boundaries: WordBoundary[],
  audioDuration: number,
  phonemeBoundaries?: PhonemeBoundary[],
): VisemeEvent[] {
  const duration = Number.isFinite(audioDuration) ? Math.max(0, audioDuration) : 0;
  const timeline: VisemeEvent[] = [];

  // Priority A: If real acoustic phoneme boundaries are provided, map directly to visemes
  if (phonemeBoundaries && phonemeBoundaries.length > 0) {
    const sortedPhonemes = [...phonemeBoundaries].sort((a, b) => a.start - b.start);
    for (const pb of sortedPhonemes) {
      if (!Number.isFinite(pb.start) || !Number.isFinite(pb.duration) || pb.duration <= 0) continue;
      const pStart = Math.min(duration, Math.max(0, pb.start));
      const pEnd = Math.min(duration, Math.max(pStart, pb.start + pb.duration));
      if (pEnd <= pStart) continue;

      const normPhoneme = pb.phoneme.toLowerCase().trim();
      const viseme = PHONEME_TO_VISEME[normPhoneme] ?? "ldt";
      const prev = timeline[timeline.length - 1];
      if (prev && prev.viseme === viseme && Math.abs(prev.end - pStart) < 0.005) {
        prev.end = pEnd;
      } else {
        timeline.push({ start: pStart, end: pEnd, viseme });
      }
    }
    if (timeline.length > 0) {
      return timeline;
    }
  }

  // Fallback: Use verified syllable-aware duration estimation on word boundaries
  const sorted = [...boundaries].sort((a, b) => a.start - b.start);

  for (const boundary of sorted) {
    if (!Number.isFinite(boundary.start) || !Number.isFinite(boundary.duration) || boundary.duration <= 0) continue;

    const previousEnd = timeline[timeline.length - 1]?.end ?? 0;
    const boundaryStart = Math.min(duration, Math.max(0, boundary.start, previousEnd));
    const boundaryEnd = Math.min(duration, Math.max(boundaryStart, boundary.start + boundary.duration));
    if (boundaryEnd <= boundaryStart) continue;

    // Defense-in-depth: normalize boundary token if it contains digits, acronyms, or symbols
    const words = normalizeBoundaryToken(boundary.text);
    if (!words.length) continue;

    const boundaryDuration = boundaryEnd - boundaryStart;
    const wordDurationSlice = boundaryDuration / words.length;

    for (let wIdx = 0; wIdx < words.length; wIdx += 1) {
      const word = words[wIdx];
      const wordStart = boundaryStart + wordDurationSlice * wIdx;
      const wordEnd = boundaryStart + wordDurationSlice * (wIdx + 1);
      const { phonemes, source } = resolveWordPhonemes(word);

      if (!phonemes.length) continue;

      const visemes = phonemes.map((p) => PHONEME_TO_VISEME[p] ?? "ldt");
      const wordDurationSec = wordEnd - wordStart;
      const pDurations = computeSyllableAwareDurations(phonemes, wordDurationSec);

      if (process.env.NODE_ENV !== "production") {
        console.info("[local-avatar] lipsync_word_diagnostic", {
          originalToken: boundary.text,
          normalizedWord: word,
          source,
          phonemes,
          visemes,
          start: wordStart.toFixed(3),
          end: wordEnd.toFixed(3),
        });
      }

      let currentT = wordStart;
      for (let pIdx = 0; pIdx < phonemes.length; pIdx += 1) {
        const pDuration = pDurations[pIdx];
        const pStart = currentT;
        const pEnd = pIdx === phonemes.length - 1 ? wordEnd : currentT + pDuration;
        currentT = pEnd;

        const viseme = visemes[pIdx];
        const prev = timeline[timeline.length - 1];
        if (prev && prev.viseme === viseme && Math.abs(prev.end - pStart) < 0.001) {
          prev.end = pEnd;
        } else {
          timeline.push({ start: pStart, end: pEnd, viseme });
        }
      }
    }
  }
  return timeline;
}

export function findVisemeAtTime(timeline: VisemeEvent[], time: number): LocalViseme | null {
  let low = 0;
  let high = timeline.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const event = timeline[mid];
    if (time < event.start) high = mid - 1;
    else if (time >= event.end) low = mid + 1;
    else return event.viseme;
  }
  return null;
}

/**
 * Post-process a raw viseme timeline to reduce visual pose churn.
 *
 * Goals:
 *   - Merge adjacent identical visemes.
 *   - Merge very short low-priority events into their more visually dominant neighbour.
 *   - Enforce per-viseme minimum dwell times where the available time budget allows.
 *   - Preserve first-event start and last-event end exactly.
 *   - Never stretch total timeline duration.
 *   - Never reorder events or introduce overlaps.
 *   - Never alter the AudioContext clock.
 *
 * @param raw        Output of buildVisemeTimeline.
 * @param utteranceEnd  Authoritative audio end time (seconds). Equals decoded.duration.
 * @returns  Stabilized, non-overlapping, ordered VisemeEvent[].
 */
export function stabilizeVisemeTimeline(raw: VisemeEvent[], utteranceEnd: number): VisemeEvent[] {
  if (raw.length === 0) return [];

  // ── Pass 1: merge adjacent identical visemes ──────────────────────────────
  const merged: VisemeEvent[] = [];
  for (const ev of raw) {
    const last = merged[merged.length - 1];
    if (last && last.viseme === ev.viseme && Math.abs(last.end - ev.start) < 0.002) {
      last.end = ev.end;
    } else {
      merged.push({ ...ev });
    }
  }

  // ── Pass 2: absorb low-priority short events into dominant neighbours ─────
  // Threshold: events shorter than their minimum dwell AND lower priority than
  // at least one adjacent event are candidates for absorption.
  let working = merged;
  let changed = true;
  let safetyLimit = 20; // guard against unexpected cycles
  while (changed && safetyLimit-- > 0) {
    changed = false;
    const next: VisemeEvent[] = [];
    for (let i = 0; i < working.length; i += 1) {
      const ev = working[i];
      const durMs = (ev.end - ev.start) * 1000;
      const minMs = VISEME_MIN_DWELL_S[ev.viseme] * 1000;
      const priority = VISEME_PRIORITY[ev.viseme];

      // Never absorb: first event, last event, or an event that already meets minimum.
      if (i === 0 || i === working.length - 1 || durMs >= minMs) {
        next.push(ev);
        continue;
      }

      const prevEv = next[next.length - 1]; // already in next[]
      const nextEv = working[i + 1];

      const prevPriority = VISEME_PRIORITY[prevEv.viseme];
      const nextPriority = VISEME_PRIORITY[nextEv.viseme];

      // Absorb only if this event is strictly lower priority than a neighbour.
      if (priority >= prevPriority && priority >= nextPriority) {
        next.push(ev);
        continue;
      }

      // Choose the dominant neighbour (higher priority wins; prefer prev on tie).
      if (prevPriority >= nextPriority) {
        // Absorb into previous: extend prev to cover this event's end.
        prevEv.end = ev.end;
      } else {
        // Absorb into next: pull next's start back to this event's start.
        working[i + 1] = { ...nextEv, start: ev.start };
      }
      changed = true;
      // Do not push ev — it has been absorbed.
    }
    working = next;
  }

  // ── Pass 3: re-merge any identical neighbours created by absorption ───────
  const remerged: VisemeEvent[] = [];
  for (const ev of working) {
    const last = remerged[remerged.length - 1];
    if (last && last.viseme === ev.viseme && Math.abs(last.end - ev.start) < 0.002) {
      last.end = ev.end;
    } else {
      remerged.push({ ...ev });
    }
  }

  // ── Pass 4: clamp and enforce non-overlap ─────────────────────────────────
  for (let i = 0; i < remerged.length; i += 1) {
    if (i > 0) {
      // Ensure no overlap with previous event.
      remerged[i].start = Math.max(remerged[i].start, remerged[i - 1].end);
    }
    remerged[i].end = Math.max(remerged[i].end, remerged[i].start + 0.010); // 10ms floor
  }

  // ── Pass 5: restore authoritative boundaries ─────────────────────────────
  if (remerged.length > 0) {
    // First event start must equal the raw timeline's first event start.
    remerged[0].start = raw[0].start;
    // Last event end must be exactly utteranceEnd (or clamped to it).
    remerged[remerged.length - 1].end = Math.min(utteranceEnd, remerged[remerged.length - 1].end);
    // Re-check floor on first event after boundary restoration.
    if (remerged[0].end <= remerged[0].start) {
      remerged[0].end = remerged[0].start + 0.010;
    }
  }

  return remerged;
}
