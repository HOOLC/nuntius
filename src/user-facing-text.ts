import path from "node:path";

const ABSOLUTE_PATH_PATTERN =
  /(^|[\s([{"'`=])((?:\/[^/\s`"'<>]+){2,}\/?)(?=$|[\s)\]}"'`,.!?:;])/g;

export function sanitizeUserFacingText(text: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, (_match, prefix: string, absolutePath: string) => {
    const normalizedPath =
      absolutePath.length > 1 && absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
    const baseName = path.basename(normalizedPath);
    return `${prefix}${baseName || "[path]"}`;
  });
}
