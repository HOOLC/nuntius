import type { SandboxMode } from "./domain.js";

export interface CodexNetworkAccessConfig {
  allowCodexNetworkAccess?: boolean;
  codexNetworkAccessWorkspacePath?: string;
  sandboxMode?: SandboxMode;
}

type EnabledCodexNetworkAccessConfig = CodexNetworkAccessConfig & {
  allowCodexNetworkAccess: true;
  codexNetworkAccessWorkspacePath: string;
};

const CODEX_SEARCH_INVOCATION = "codex --search";
const CODEX_WORKSPACE_WRITE_NETWORK_ACCESS_OVERRIDE =
  "sandbox_workspace_write.network_access=true";

export function hasCodexNetworkAccess(
  value: CodexNetworkAccessConfig | undefined
): value is EnabledCodexNetworkAccessConfig {
  return Boolean(value?.allowCodexNetworkAccess && value.codexNetworkAccessWorkspacePath);
}

export function formatCodexNetworkAccess(
  value: CodexNetworkAccessConfig | undefined
): string {
  if (!hasCodexNetworkAccess(value)) {
    return "disabled for this repository";
  }

  return `requested via ${formatCodexNetworkAccessRequest(value)} (${value.codexNetworkAccessWorkspacePath})`;
}

export function buildCodexNetworkAccessStartNote(
  value: CodexNetworkAccessConfig | undefined
): string | undefined {
  if (!hasCodexNetworkAccess(value)) {
    return undefined;
  }

  return `Network access requested via ${formatCodexNetworkAccessRequest(value)}; artifacts workspace: \`${value.codexNetworkAccessWorkspacePath}\`. The host must still allow Codex to reach chatgpt.com and let worker tools resolve/connect to external hosts.`;
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
    `Codex network access was requested for this worker session via ${formatCodexNetworkAccessRequest(value)}.`,
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
    lines.push(...buildHostNetworkDiagnostics(errorMessage));
  }

  return [...lines, "", "Original error:", errorMessage].join("\n");
}

function buildHostNetworkDiagnostics(errorMessage: string): string[] {
  const diagnostics: string[] = [];

  if (hasSocketPermissionFailure(errorMessage)) {
    diagnostics.push(
      "Detected outbound socket blocking while the Codex CLI was trying to reach chatgpt.com over WebSocket/HTTPS; fix the host sandbox or firewall so Codex itself can open external connections."
    );
  }

  if (hasDnsResolutionFailure(errorMessage)) {
    diagnostics.push(
      "Detected DNS resolution failure for an external host; fix the host resolver/proxy/network setup so worker tools such as git, ssh, and curl can resolve remote names."
    );
  }

  return diagnostics;
}

function formatCodexNetworkAccessRequest(value: EnabledCodexNetworkAccessConfig): string {
  if (value.sandboxMode === "workspace-write") {
    return `\`${CODEX_SEARCH_INVOCATION}\` and \`-c ${CODEX_WORKSPACE_WRITE_NETWORK_ACCESS_OVERRIDE}\``;
  }

  if (value.sandboxMode === "danger-full-access") {
    return `\`${CODEX_SEARCH_INVOCATION}\` with \`danger-full-access\``;
  }

  return `\`${CODEX_SEARCH_INVOCATION}\``;
}

function hasSocketPermissionFailure(errorMessage: string): boolean {
  return (
    errorMessage.includes("Operation not permitted") ||
    errorMessage.includes("failed to connect to websocket") ||
    errorMessage.includes("error sending request for url") ||
    errorMessage.includes("stream disconnected before completion")
  );
}

function hasDnsResolutionFailure(errorMessage: string): boolean {
  return (
    errorMessage.includes("Temporary failure in name resolution") ||
    errorMessage.includes("Could not resolve hostname") ||
    errorMessage.includes("Could not resolve host")
  );
}
