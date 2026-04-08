import { randomInt } from "node:crypto";

const MAX_THREAD_NAME_LENGTH = 100;
const MAX_SEED_LENGTH = 80;
const DEFAULT_SEED = "session";
const RANDOM_WORD_SUFFIX_MAX_LENGTH = 24;
const THREAD_NAME_ADJECTIVES = [
  "amber",
  "brisk",
  "cedar",
  "clear",
  "cobalt",
  "daring",
  "frost",
  "gentle",
  "golden",
  "lively",
  "mellow",
  "midnight",
  "misty",
  "rapid",
  "silver",
  "steady"
] as const;
const THREAD_NAME_NOUNS = [
  "badger",
  "brook",
  "comet",
  "ember",
  "falcon",
  "forest",
  "harbor",
  "meadow",
  "otter",
  "pine",
  "river",
  "sparrow",
  "stone",
  "summit",
  "willow",
  "zephyr"
] as const;

export function buildDiscordThreadName(
  prefix: string,
  seed: string,
  randomSuffix: string = generateDiscordThreadNameSuffix()
): string {
  const normalizedSeed = normalizeThreadNameSegment(seed).slice(0, MAX_SEED_LENGTH) || DEFAULT_SEED;
  const normalizedSuffix =
    normalizeThreadNameSegment(randomSuffix).slice(0, RANDOM_WORD_SUFFIX_MAX_LENGTH) ||
    generateDiscordThreadNameSuffix();
  const suffixPart = `-${normalizedSuffix}`;
  const maxLeadLength = Math.max(0, MAX_THREAD_NAME_LENGTH - suffixPart.length);
  const lead = `${prefix}-${normalizedSeed}`.slice(0, maxLeadLength).replace(/-+$/g, "");

  return `${lead}${suffixPart}`;
}

export function generateDiscordThreadNameSuffix(): string {
  return `${pickRandomWord(THREAD_NAME_ADJECTIVES)}-${pickRandomWord(THREAD_NAME_NOUNS)}`;
}

function normalizeThreadNameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pickRandomWord(words: readonly string[]): string {
  return words[randomInt(words.length)] ?? words[0];
}
