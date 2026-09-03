/**
 * TextNormalizer.ts
 *
 * Canonical speech/text normalization layer placed immediately before TTS synthesis.
 * Converts written numbers, ordinals, currency, percentages, and symbols into spoken words
 * so Edge TTS and the lip-sync timeline both receive spoken English text.
 */

export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "zero";
  if (n < 0) return "negative " + integerToWords(Math.abs(n));

  const ones = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  ];

  function helper(num: number): string {
    if (num < 20) return ones[num];
    if (num < 100) {
      const rem = num % 10;
      return tens[Math.floor(num / 10)] + (rem ? " " + ones[rem] : "");
    }
    if (num < 1000) {
      const rem = num % 100;
      return ones[Math.floor(num / 100)] + " hundred" + (rem ? " " + helper(rem) : "");
    }
    if (num < 1000000) {
      const rem = num % 1000;
      return helper(Math.floor(num / 1000)) + " thousand" + (rem ? " " + helper(rem) : "");
    }
    if (num < 1000000000) {
      const rem = num % 1000000;
      return helper(Math.floor(num / 1000000)) + " million" + (rem ? " " + helper(rem) : "");
    }
    return String(num);
  }

  return helper(n);
}

export function ordinalToWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const special: Record<number, string> = {
    1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
    6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
    11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth", 15: "fifteenth",
    16: "sixteenth", 17: "seventeenth", 18: "eighteenth", 19: "nineteenth",
    20: "twentieth", 30: "thirtieth", 40: "fortieth", 50: "fiftieth",
    60: "sixtieth", 70: "seventieth", 80: "eightieth", 90: "ninetieth",
    100: "one hundredth", 1000: "one thousandth",
  };
  if (special[n]) return special[n];
  if (n > 20 && n < 100) {
    const tensVal = Math.floor(n / 10);
    const onesVal = n % 10;
    const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
    return tens[tensVal] + " " + (special[onesVal] || ordinalToWords(onesVal));
  }
  const cardinal = integerToWords(n);
  if (cardinal.endsWith("y")) return cardinal.slice(0, -1) + "ieth";
  return cardinal + "th";
}

/**
 * Technical initialisms expanded letter-by-letter into spoken English syllables.
 */
export const TECHNICAL_INITIALISMS: Record<string, string> = {
  api: "ay pee eye",
  http: "aitch tee tee pee",
  https: "aitch tee tee pee ess",
  html: "aitch tee em el",
  css: "see ess ess",
  jwt: "jay double you tee",
  aws: "ay double you ess",
  gcp: "jee see pee",
  llm: "el el em",
  gpt: "jee pee tee",
  cli: "see el eye",
  sdk: "ess dee kay",
  url: "you are el",
  uri: "you are eye",
  ssh: "ess ess aitch",
  tcp: "tee see pee",
  udp: "you dee pee",
  cpu: "see pee you",
  gpu: "jee pee you",
  ram: "ram",
  os: "oh ess",
  ide: "eye dee ee",
  db: "dee bee",
  dbms: "dee bee em ess",
  ui: "you eye",
  ux: "you ex",
};

/**
 * Technical acronyms pronounced as spoken words or custom compounds.
 */
export const TECHNICAL_ACRONYMS: Record<string, string> = {
  "ci/cd": "see eye see dee",
  "tcp/ip": "tee see pee eye pee",
  "node.js": "node jay ess",
  "next.js": "next jay ess",
  postgresql: "postgres sequel",
  fastapi: "fast ay pee eye",
  graphql: "graph cue el",
  mongodb: "mongo dee bee",
  mysql: "my sequel",
  nosql: "no sequel",
  sql: "sequel",
  json: "jason",
  rest: "rest",
  oauth: "oh auth",
  saas: "sass",
  gui: "gooey",
  numpy: "num pie",
  pytorch: "pie torch",
  tensorflow: "tensor flow",
  kubernetes: "koo ber net eez",
  docker: "docker",
  redis: "red iss",
  kafka: "kafka",
  github: "git hub",
  linux: "linn ucks",
  ubuntu: "oo boon too",
};

/**
 * Normalize full sentence text into spoken representation for Edge TTS.
 */
export function normalizeTextForSpeech(text: string): string {
  if (!text) return "";
  let s = text;

  // Abbreviations
  s = s.replace(/\be\.g\.,?\b/gi, "for example");
  s = s.replace(/\bi\.e\.,?\b/gi, "that is");
  s = s.replace(/\betc\.\b/gi, "etcetera");
  s = s.replace(/\bvs\.?\b/gi, "versus");

  // Technical compounds (e.g. CI/CD, TCP/IP, Node.js, Next.js, PostgreSQL)
  for (const [key, replacement] of Object.entries(TECHNICAL_ACRONYMS)) {
    const escaped = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "gi");
    s = s.replace(regex, replacement);
  }

  // Technical initialisms (e.g. API, HTTP, HTML, CSS, LLM, GPT, JWT)
  for (const [key, replacement] of Object.entries(TECHNICAL_INITIALISMS)) {
    const regex = new RegExp(`\\b${key}\\b`, "gi");
    s = s.replace(regex, replacement);
  }

  // Currency: $100, $25.50
  s = s.replace(/\$(\d+)\.(\d{2})\b/g, (_, dollars, cents) => {
    const d = integerToWords(parseInt(dollars, 10));
    const c = integerToWords(parseInt(cents, 10));
    return `${d} dollars and ${c} cents`;
  });
  s = s.replace(/\$(\d+)\b/g, (_, dollars) => {
    const d = integerToWords(parseInt(dollars, 10));
    return `${d} dollar${dollars === "1" ? "" : "s"}`;
  });

  // Percentages: 50%, 2.5%
  s = s.replace(/(\d+)\.(\d+)%/g, (_, whole, dec: string) => {
    const w = integerToWords(parseInt(whole, 10));
    const d = dec.split("").map((digit) => integerToWords(parseInt(digit, 10))).join(" ");
    return `${w} point ${d} percent`;
  });
  s = s.replace(/(\d+)%/g, (_, num) => {
    return `${integerToWords(parseInt(num, 10))} percent`;
  });

  // Ordinals: 1st, 2nd, 3rd, 25th, etc.
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, num) => {
    return ordinalToWords(parseInt(num, 10));
  });

  // Decimals: 3.14
  s = s.replace(/\b(\d+)\.(\d+)\b/g, (_, whole, dec: string) => {
    const w = integerToWords(parseInt(whole, 10));
    const d = dec.split("").map((digit) => integerToWords(parseInt(digit, 10))).join(" ");
    return `${w} point ${d}`;
  });

  // Years: 1900-2099
  s = s.replace(/\b(19\d{2}|20\d{2})\b/g, (_, yearStr) => {
    const y = parseInt(yearStr, 10);
    if (y === 2000) return "two thousand";
    if (y > 2000 && y < 2010) return "two thousand " + integerToWords(y - 2000);
    const top = Math.floor(y / 100);
    const bottom = y % 100;
    return integerToWords(top) + " " + integerToWords(bottom);
  });

  // Cardinals: standalone integers
  s = s.replace(/\b\d+\b/g, (match) => {
    return integerToWords(parseInt(match, 10));
  });

  // Symbols
  s = s.replace(/\s*&\s*/g, " and ");
  s = s.replace(/#/g, "number ");
  s = s.replace(/\s*\+\s*/g, " plus ");
  s = s.replace(/\s*=\s*/g, " equals ");

  return s.replace(/\s+/g, " ").trim();
}

/**
 * Defense-in-depth boundary normalizer:
 * If a WordBoundary token still contains raw digits, currency, or ordinals,
 * expands it into individual spoken words for phonetic lookup.
 */
export function normalizeBoundaryToken(token: string): string[] {
  const cleaned = token.trim();
  if (!cleaned) return [];

  const lower = cleaned.toLowerCase().replace(/[^a-z0-9\/\.]/g, "");
  // Direct check for technical acronyms or initialisms
  if (TECHNICAL_ACRONYMS[lower]) {
    return TECHNICAL_ACRONYMS[lower].split(/\s+/);
  }
  if (TECHNICAL_INITIALISMS[lower]) {
    return TECHNICAL_INITIALISMS[lower].split(/\s+/);
  }

  // If token is already alphabetic word, return directly
  if (/^[a-zA-Z]+$/.test(cleaned)) {
    return [cleaned.toLowerCase()];
  }

  // Normalize using spoken text rules
  const normalized = normalizeTextForSpeech(cleaned);
  const words = normalized
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  return words.length > 0 ? words : [cleaned.toLowerCase().replace(/[^a-z0-9]/g, "")];
}

