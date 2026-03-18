import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const counterPath = process.env.NUNTIUS_TEST_COUNTER_PATH;

if (!counterPath) {
  throw new Error("NUNTIUS_TEST_COUNTER_PATH is required.");
}

const restartCount = Number(process.env.NUNTIUS_TEST_RESTARTS ?? "1");
const finalExitCode = Number(process.env.NUNTIUS_TEST_FINAL_EXIT_CODE ?? "0");
const currentCount = Number(readFileSync(counterPath, "utf8"));
const nextCount = currentCount + 1;

writeFileSync(counterPath, String(nextCount));

if (nextCount <= restartCount) {
  process.exit(75);
}

process.exit(finalExitCode);
