export function trimCodeFencePayload(value: string): string {
  return value.replace(/```/g, "`\u200b``").trim();
}

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;

export function formatDiscordMessageText(value: string): string {
  return replaceOutsideCodeFences(value, (segment) =>
    segment.replace(MARKDOWN_LINK_PATTERN, (_match, label: string, target: string) =>
      renderDiscordLink(label, target)
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

function renderDiscordLink(label: string, target: string): string {
  const normalizedLabel = label.trim();
  const normalizedTarget = target.trim();

  if (isExternalLinkTarget(normalizedTarget)) {
    return normalizedLabel === normalizedTarget
      ? `<${normalizedTarget}>`
      : `${normalizedLabel} <${normalizedTarget}>`;
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
