export interface CodexNetworkAccessConfig {
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
}

const CODEX_SEARCH_INVOCATION = "codex --search";

export function hasCodexNetworkAccess(
  value: CodexNetworkAccessConfig | undefined
): value is Required<CodexNetworkAccessConfig> {
  return Boolean(value?.allowCodexNetworkAccess && value.codexNetworkAccessWorkspacePath);
}

export function formatCodexNetworkAccess(
  value: CodexNetworkAccessConfig | undefined
): string {
  if (!hasCodexNetworkAccess(value)) {
    return "disabled for this repository";
  }

  return `requested via \`${CODEX_SEARCH_INVOCATION}\` (${value.codexNetworkAccessWorkspacePath})`;
}

export function buildCodexNetworkAccessStartNote(
  value: CodexNetworkAccessConfig | undefined
): string | undefined {
  if (!hasCodexNetworkAccess(value)) {
    return undefined;
  }

  return `Web access requested via \`${CODEX_SEARCH_INVOCATION}\`; artifacts workspace: \`${value.codexNetworkAccessWorkspacePath}\`. Host policy can still block outbound access.`;
}

export function buildCodexNetworkAccessFailureMessage(
  value: CodexNetworkAccessConfig | undefined,
  errorMessage: string
): string {
  if (!hasCodexNetworkAccess(value)) {
    return errorMessage;
  }

  if (errorMessage.includes("Codex network access was requested for this worker session")) {
    return errorMessage;
  }

  const lines = [
    `Codex network access was requested for this worker session via \`${CODEX_SEARCH_INVOCATION}\`.`,
    `Artifacts workspace: ${value.codexNetworkAccessWorkspacePath}.`
  ];

  if (errorMessage.includes("unexpected argument '--search'")) {
    lines.push(
      "The installed Codex CLI does not support `--search`; upgrade Codex or disable allow_codex_network_access for this repository target."
    );
  } else {
    lines.push(
      "The host Codex runtime and OS/network policy must still allow outbound access; nuntius cannot bypass those limits."
    );
  }

  return [...lines, "", "Original error:", errorMessage].join("\n");
}
