import type { HostCapabilities } from "../../kernel/host-capabilities";
import { requireHostCapability } from "../../kernel/host-capabilities";

/** Host-neutral question shape accepted by the CLI interaction adapter. */
export interface CliAskRequest {
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Minimal prompt service supplied by the concrete terminal host. */
export interface CliPromptIO {
  prompt(text: string): Promise<string>;
}

/** Host-side user interaction service; policy decisions still belong to ToolRuntime. */
export interface CliInteractionService {
  askUser(request: CliAskRequest): Promise<string>;
  requestPermission(toolName: string): Promise<{ allow: boolean; reason: string }>;
  requestMcpPermission(toolName: string, description: string): Promise<"allow" | "once" | "">;
}

function renderAskRequest(request: CliAskRequest): string {
  const lines = [`\n${request.question.trim() || "FreeSeek needs input."}`];
  if (request.options?.length) {
    request.options.forEach((option, index) => {
      lines.push(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    });
    lines.push(request.multiSelect ? "Select option number(s), comma-separated, or type a response: " : "Select an option number or type a response: ");
  } else {
    lines.push("Response: ");
  }
  return lines.join("\n");
}

function normalizeAnswer(request: CliAskRequest, raw: string): string {
  const answer = raw.trim();
  if (!answer || !request.options?.length) return answer;
  const indexes = answer
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= request.options!.length);
  if (!indexes.length) return answer;
  const selected = [...new Set(indexes)].map((index) => request.options![index - 1].label);
  return request.multiSelect ? selected.join(", ") : selected[0];
}

/** Create an explicit CLI interaction service; unavailable capabilities fail closed. */
export function createCliInteractionService(
  capabilities: HostCapabilities,
  io: CliPromptIO
): CliInteractionService {
  return {
    async askUser(request) {
      requireHostCapability(capabilities, "interactiveInput", "interactive ask_user");
      return normalizeAnswer(request, await io.prompt(renderAskRequest(request)));
    },
    async requestPermission(toolName) {
      requireHostCapability(capabilities, "permissionPrompt", "interactive permission prompt");
      const answer = (await io.prompt(`\nApprove tool '${toolName}'? [y/N]: `)).trim().toLowerCase();
      const allow = answer === "y" || answer === "yes";
      return {
        allow,
        reason: allow ? "approved by CLI user" : "denied by CLI user",
      };
    },
    async requestMcpPermission(toolName, description) {
      requireHostCapability(capabilities, "mcp", "MCP tool access");
      requireHostCapability(capabilities, "permissionPrompt", "interactive MCP permission prompt");
      const detail = description.trim() ? `\n${description.trim()}` : "";
      const answer = (await io.prompt(
        `\nApprove external MCP tool '${toolName}'?${detail}\n[a]llow for session / [o]nce / [N] deny: `
      )).trim().toLowerCase();
      if (answer === "a" || answer === "allow" || answer === "always") return "allow";
      if (answer === "o" || answer === "once" || answer === "y" || answer === "yes") return "once";
      return "";
    },
  };
}
