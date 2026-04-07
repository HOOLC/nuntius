export function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;

export function formatDiscordMessageText(value: string): string {
  return replaceOutsideCodeFences(value, (segment) =>
    segment.replace(MARKDOWN_LINK_PATTERN, (_match, label: string, target: string) =>
      renderChatLink("discord", label, target)
    )
  );
}

export function formatFeishuMessageText(value: string): string {
  return replaceOutsideCodeFences(value, (segment) =>
    collapseExcessBlankLines(
      stripMarkdownDecorations(rewriteMarkdownTables(segment)).replace(
        MARKDOWN_LINK_PATTERN,
        (_match, label: string, target: string) => renderChatLink("feishu", label, target)
      )
    )
  );
}

function replaceOutsideCodeFences(
  value: string,
  transform: (segment: string) => string
): string {
  let result = "";
  let lastIndex = 0;

  for (const match of value.matchAll(CODE_FENCE_PATTERN)) {
    const index = match.index ?? 0;
    result += transform(value.slice(lastIndex, index));
    result += match[0];
    lastIndex = index + match[0].length;
  }

  result += transform(value.slice(lastIndex));
  return result;
}

function rewriteMarkdownTables(value: string): string {
  const lines = value.split("\n");
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];

    if (!looksLikeMarkdownTableHeader(header, separator)) {
      rendered.push(lines[index]);
      continue;
    }

    const headers = splitMarkdownTableRow(header);
    index += 2;

    while (index < lines.length && looksLikeMarkdownTableRow(lines[index])) {
      const cells = splitMarkdownTableRow(lines[index]);
      const pairs = headers
        .map((heading, cellIndex) => {
          const normalizedHeading = heading.trim();
          const normalizedValue = (cells[cellIndex] ?? "").trim();
          if (!normalizedHeading && !normalizedValue) {
            return undefined;
          }

          if (!normalizedHeading) {
            return normalizedValue;
          }

          if (!normalizedValue) {
            return normalizedHeading;
          }

          return `${normalizedHeading}: ${normalizedValue}`;
        })
        .filter((value): value is string => Boolean(value));

      if (pairs.length > 0) {
        rendered.push(`- ${pairs.join("; ")}`);
      }

      index += 1;
    }

    index -= 1;
  }

  return rendered.join("\n");
}

function stripMarkdownDecorations(value: string): string {
  return value
    .replace(/^#{1,6}[ \t]+(.+)[ \t]*$/gm, (_match, heading: string) => heading.trim())
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    .replace(/(^|[^\w])\*\*([^*\n]+)\*\*(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])~~([^~\n]+)~~(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2");
}

function collapseExcessBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n");
}

function looksLikeMarkdownTableHeader(
  headerLine: string | undefined,
  separatorLine: string | undefined
): boolean {
  if (!headerLine || !separatorLine) {
    return false;
  }

  const headerCells = splitMarkdownTableRow(headerLine);
  return headerCells.length > 1 && isMarkdownTableSeparator(separatorLine, headerCells.length);
}

function looksLikeMarkdownTableRow(value: string): boolean {
  return splitMarkdownTableRow(value).length > 1;
}

function splitMarkdownTableRow(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.includes("|")) {
    return [];
  }

  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparator(value: string, expectedColumns: number): boolean {
  const cells = splitMarkdownTableRow(value);
  if (cells.length !== expectedColumns) {
    return false;
  }

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderChatLink(mode: "discord" | "feishu", label: string, target: string): string {
  const normalizedLabel = label.trim();
  const normalizedTarget = target.trim();

  if (isExternalLinkTarget(normalizedTarget)) {
    if (normalizedLabel === normalizedTarget) {
      return mode === "discord" ? `<${normalizedTarget}>` : normalizedTarget;
    }

    return mode === "discord"
      ? `${normalizedLabel} <${normalizedTarget}>`
      : `${normalizedLabel}: ${normalizedTarget}`;
  }

  if (!looksLikeFileReferenceTarget(normalizedTarget)) {
    return normalizedLabel;
  }

  const lineSuffix = extractLineSuffix(normalizedTarget);
  if (!lineSuffix || normalizedLabel.endsWith(`:${lineSuffix}`)) {
    return normalizedLabel;
  }

  return `${normalizedLabel}:${lineSuffix}`;
}

function isExternalLinkTarget(target: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(target);
}

function looksLikeFileReferenceTarget(target: string): boolean {
  return (
    target.startsWith("/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    /[\\/]/.test(target) ||
    /\.[A-Za-z0-9]+(?:$|[#:])/.test(target)
  );
}

function extractLineSuffix(target: string): string | undefined {
  const hashAnchorMatch = target.match(/#L(\d+)(?:C(\d+))?$/i);
  if (hashAnchorMatch) {
    return hashAnchorMatch[2]
      ? `${hashAnchorMatch[1]}:${hashAnchorMatch[2]}`
      : hashAnchorMatch[1];
  }

  const colonSuffixMatch = target.match(/:(\d+)(?::(\d+))?$/);
  if (colonSuffixMatch) {
    return colonSuffixMatch[2]
      ? `${colonSuffixMatch[1]}:${colonSuffixMatch[2]}`
      : colonSuffixMatch[1];
  }

  return undefined;
}
