import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "smol-toml";

export interface LoadedConfigFile {
  path: string;
  dir: string;
  document: Record<string, unknown>;
}

export function loadNuntiusConfigFile(): LoadedConfigFile | undefined {
  const configuredPath = process.env.NUNTIUS_CONFIG_PATH;
  const candidatePath = path.resolve(configuredPath ?? "nuntius.toml");

  if (!existsSync(candidatePath)) {
    if (configuredPath) {
      throw new Error(`Nuntius config file not found: ${candidatePath}`);
    }

    return undefined;
  }

  const raw = readFileSync(candidatePath, "utf8");
  const document = parse(raw) as unknown;

  if (!isRecord(document)) {
    throw new Error(`Nuntius config file must parse to a TOML table: ${candidatePath}`);
  }

  return {
    path: candidatePath,
    dir: path.dirname(candidatePath),
    document
  };
}

export function readTable(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Expected ${key} to be a TOML table.`);
  }

  return value;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }

  return value;
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected ${key} to be a boolean.`);
  }

  return value;
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }

  return value;
}

export function readStringArray(
  record: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${key} to be an array of strings.`);
  }

  return value;
}

export function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an array.`);
  }

  return value;
}

export function resolveConfigRelativePath(
  loadedConfig: LoadedConfigFile | undefined,
  value: string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (!loadedConfig || path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(loadedConfig.dir, value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
