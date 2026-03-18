import { localize } from "./conversation-language.js";
import type { ConversationLanguage, SandboxMode } from "./domain.js";

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
  value: CodexNetworkAccessConfig | undefined,
  language: ConversationLanguage = "en"
): string {
  if (!hasCodexNetworkAccess(value)) {
    return localize(language, {
      en: "disabled for this repository",
      zh: "此仓库未启用"
    });
  }

  return localize(language, {
    en: `requested via ${formatCodexNetworkAccessRequest(value)} (${value.codexNetworkAccessWorkspacePath})`,
    zh: `已通过 ${formatCodexNetworkAccessRequest(value)} 请求 (${value.codexNetworkAccessWorkspacePath})`
  });
}

export function buildCodexNetworkAccessStartNote(
  value: CodexNetworkAccessConfig | undefined,
  language: ConversationLanguage = "en"
): string | undefined {
  if (!hasCodexNetworkAccess(value)) {
    return undefined;
  }

  return localize(language, {
    en: `Network access requested via ${formatCodexNetworkAccessRequest(value)}; artifacts workspace: \`${value.codexNetworkAccessWorkspacePath}\`. The host must still allow Codex to reach chatgpt.com and let worker tools resolve/connect to external hosts.`,
    zh: `已通过 ${formatCodexNetworkAccessRequest(value)} 请求网络访问；产物工作区：\`${value.codexNetworkAccessWorkspacePath}\`。宿主环境仍需允许 Codex 访问 chatgpt.com，并允许工作进程解析并连接外部主机。`
  });
}

export function buildCodexNetworkAccessFailureMessage(
  value: CodexNetworkAccessConfig | undefined,
  errorMessage: string,
  language: ConversationLanguage = "en"
): string {
  if (!hasCodexNetworkAccess(value)) {
    return errorMessage;
  }

  if (
    errorMessage.includes("Codex network access was requested for this worker session") ||
    errorMessage.includes("此 worker session 已请求 Codex 网络访问")
  ) {
    return errorMessage;
  }

  const lines = localize(language, {
    en: [
      `Codex network access was requested for this worker session via ${formatCodexNetworkAccessRequest(value)}.`,
      `Artifacts workspace: ${value.codexNetworkAccessWorkspacePath}.`
    ],
    zh: [
      `此 worker session 已通过 ${formatCodexNetworkAccessRequest(value)} 请求 Codex 网络访问。`,
      `产物工作区：${value.codexNetworkAccessWorkspacePath}。`
    ]
  });

  if (errorMessage.includes("unexpected argument '--search'")) {
    lines.push(
      localize(language, {
        en: "The installed Codex CLI does not support `--search`; upgrade Codex or disable allow_codex_network_access for this repository target.",
        zh: "当前安装的 Codex CLI 不支持 `--search`；请升级 Codex，或为该仓库目标关闭 allow_codex_network_access。"
      })
    );
  } else {
    lines.push(
      localize(language, {
        en: "The host Codex runtime and OS/network policy must still allow outbound access; nuntius cannot bypass those limits.",
        zh: "宿主机上的 Codex 运行时以及操作系统/网络策略仍需允许对外访问；nuntius 无法绕过这些限制。"
      })
    );
    lines.push(...buildHostNetworkDiagnostics(errorMessage, language));
  }

  return [
    ...lines,
    "",
    localize(language, {
      en: "Original error:",
      zh: "原始错误："
    }),
    errorMessage
  ].join("\n");
}

function buildHostNetworkDiagnostics(
  errorMessage: string,
  language: ConversationLanguage
): string[] {
  const diagnostics: string[] = [];

  if (hasSocketPermissionFailure(errorMessage)) {
    diagnostics.push(
      localize(language, {
        en: "Detected outbound socket blocking while the Codex CLI was trying to reach chatgpt.com over WebSocket/HTTPS; fix the host sandbox or firewall so Codex itself can open external connections.",
        zh: "检测到 Codex CLI 通过 WebSocket/HTTPS 访问 chatgpt.com 时被阻止建立外连 socket；请调整宿主机沙箱或防火墙，确保 Codex 本身可以访问外网。"
      })
    );
  }

  if (hasDnsResolutionFailure(errorMessage)) {
    diagnostics.push(
      localize(language, {
        en: "Detected DNS resolution failure for an external host; fix the host resolver/proxy/network setup so worker tools such as git, ssh, and curl can resolve remote names.",
        zh: "检测到外部主机 DNS 解析失败；请修复宿主机的解析器、代理或网络配置，确保 git、ssh、curl 等工具可以解析远程主机名。"
      })
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
