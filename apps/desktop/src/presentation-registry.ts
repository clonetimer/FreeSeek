import type { DesktopPresentationToolKind, DesktopPresentationUpdate } from "./presentation";
import { mergeDesktopArtifactEvidence, projectDesktopArtifactEvidence, type DesktopArtifactEvidence } from "./artifact-evidence";
import { boundedUnknownText, DESKTOP_UI_BUDGETS } from "./ui-performance";

/** Typed visual families for Desktop tool calls. Diff UI appears only when ACP projects structured evidence. */
export type DesktopToolCardKind = "terminal" | "read" | "search" | "mutation" | "web" | "code" | "generic";

/** Renderer-safe content blocks shared by conversation tool cards and trajectory details. */
export type DesktopPresentationBlockKind = "text" | "terminal" | "code" | "json";

/** One display block inside a typed presentation card. */
export interface DesktopPresentationBlock {
  label: string;
  kind: DesktopPresentationBlockKind;
  text: string;
  /** Full structured value retained by reference only when the preview is truncated; serialized only on explicit expansion. */
  source?: unknown;
  language?: string;
}

/** Stable typed presentation model derived only from projected ACP tool events. */
export interface DesktopToolPresentation {
  toolCallId: string;
  title: string;
  toolKind: DesktopPresentationToolKind;
  cardKind: DesktopToolCardKind;
  label: string;
  status: string;
  summary: string;
  input?: DesktopPresentationBlock;
  output?: DesktopPresentationBlock;
  artifacts?: DesktopArtifactEvidence[];
}

/** Message presentation intent. Rich/incremental Markdown rendering itself remains a U5 concern. */
export interface DesktopMessagePresentation {
  kind: "markdown" | "reasoning";
  label: string;
  text: string;
}

type ToolStart = Extract<DesktopPresentationUpdate, { kind: "tool"; phase: "start" }>;
type ToolUpdate = Extract<DesktopPresentationUpdate, { kind: "tool"; phase: "update" }>;
type MessageUpdate = Extract<DesktopPresentationUpdate, { kind: "assistant" | "reasoning" }>;

interface RegistryEntry {
  cardKind: DesktopToolCardKind;
  label: string;
  matches(update: ToolStart): boolean;
  summary(update: ToolStart): string;
  input(update: ToolStart): DesktopPresentationBlock | undefined;
  output(value: unknown): DesktopPresentationBlock | undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...names: string[]): string {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function jsonValue(value: unknown): unknown | undefined {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 65_536 || !/^[\[{]/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); }
  catch { return undefined; }
}

function block(label: string, value: unknown, preferred: DesktopPresentationBlockKind = "text", language?: string): DesktopPresentationBlock | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = jsonValue(value);
  const structured = parsed !== undefined ? parsed : (typeof value === "object" ? value : undefined);
  if (structured !== undefined) {
    const preview = boundedUnknownText(structured, DESKTOP_UI_BUDGETS.toolBlockPreviewChars);
    return { label, kind: parsed !== undefined && preferred === "text" ? "json" : preferred, text: preview.text, ...(preview.truncated ? { source: structured } : {}), ...(language ? { language } : {}) };
  }
  return { label, kind: preferred, text: String(value), ...(language ? { language } : {}) };
}

function compactLine(value: string, fallback: string): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (line || fallback).slice(0, 180);
}

function terminalCommand(input: Record<string, unknown> | undefined): string {
  const command = stringField(input, "command");
  if (command) return command;
  if (Array.isArray(input?.argv)) return input.argv.map((part) => String(part)).join(" ");
  return "";
}

function terminalInput(update: ToolStart): DesktopPresentationBlock | undefined {
  const input = objectRecord(update.rawInput);
  const command = terminalCommand(input);
  if (!command) return block("Command", update.rawInput, "json");
  const cwd = stringField(input, "cwd");
  return { label: cwd ? `Command · ${cwd}` : "Command", kind: "terminal", text: command };
}

function readSummary(update: ToolStart): string {
  const input = objectRecord(update.rawInput);
  const path = stringField(input, "path", "file", "file_path");
  if (!path) return update.title;
  const offset = typeof input?.offset === "number" ? input.offset : Number(input?.offset);
  const limit = typeof input?.limit === "number" ? input.limit : Number(input?.limit);
  const range = Number.isFinite(offset) && offset > 0
    ? ` · line ${offset}${Number.isFinite(limit) && limit > 0 ? `+${limit}` : ""}`
    : "";
  return `${path}${range}`;
}

function searchSummary(update: ToolStart): string {
  const input = objectRecord(update.rawInput);
  return compactLine(stringField(input, "pattern", "query"), update.title);
}

function mutationSummary(update: ToolStart): string {
  const input = objectRecord(update.rawInput);
  return compactLine(stringField(input, "path", "file", "file_path"), update.title);
}

function webSummary(update: ToolStart): string {
  const input = objectRecord(update.rawInput);
  return compactLine(stringField(input, "query", "url", "uri", "action"), update.title);
}

function codeSummary(update: ToolStart): string {
  const input = objectRecord(update.rawInput);
  const language = stringField(input, "language") || (update.title === "run_python" ? "python" : "code");
  const cwd = stringField(input, "cwd");
  return cwd ? `${language} · ${cwd}` : language;
}

function structuredInput(label: string, update: ToolStart): DesktopPresentationBlock | undefined {
  return block(label, update.rawInput, "text");
}

const TOOL_PRESENTATION_REGISTRY: readonly RegistryEntry[] = [
  {
    cardKind: "code",
    label: "Code",
    matches: (update) => /^(run_code|run_python)$/.test(update.title),
    summary: codeSummary,
    input: (update) => {
      const input = objectRecord(update.rawInput);
      const code = stringField(input, "code", "script");
      const language = stringField(input, "language") || (update.title === "run_python" ? "python" : "text");
      return code ? { label: "Code", kind: "code", text: code, language } : structuredInput("Input", update);
    },
    output: (value) => block("Output", value, "text"),
  },
  {
    cardKind: "terminal",
    label: "Terminal",
    matches: (update) => update.toolKind === "execute",
    summary: (update) => compactLine(terminalCommand(objectRecord(update.rawInput)), update.title),
    input: terminalInput,
    output: (value) => block("Output", value, "terminal"),
  },
  {
    cardKind: "read",
    label: "Read",
    matches: (update) => update.toolKind === "read",
    summary: readSummary,
    input: (update) => structuredInput("Target", update),
    output: (value) => block("Content", value, "text"),
  },
  {
    cardKind: "search",
    label: "Search",
    matches: (update) => update.toolKind === "search",
    summary: searchSummary,
    input: (update) => structuredInput("Query", update),
    output: (value) => block("Results", value, "text"),
  },
  {
    cardKind: "mutation",
    label: "Mutation",
    matches: (update) => update.toolKind === "edit" || update.toolKind === "delete" || update.toolKind === "move",
    summary: mutationSummary,
    input: (update) => structuredInput("Change request", update),
    // Raw result text remains separate from U4 file evidence; the renderer never reconstructs a diff from this text.
    output: (value) => block("Result", value, "text"),
  },
  {
    cardKind: "web",
    label: "Web",
    matches: (update) => update.toolKind === "fetch",
    summary: webSummary,
    input: (update) => structuredInput("Request", update),
    output: (value) => block("Response", value, "text"),
  },
  {
    cardKind: "generic",
    label: "Tool",
    matches: () => true,
    summary: (update) => update.title,
    input: (update) => structuredInput("Input", update),
    output: (value) => block("Output", value, "text"),
  },
] as const;

function entryFor(update: ToolStart): RegistryEntry {
  return TOOL_PRESENTATION_REGISTRY.find((entry) => entry.matches(update)) ?? TOOL_PRESENTATION_REGISTRY[TOOL_PRESENTATION_REGISTRY.length - 1]!;
}

/** Create or update the stable presentation model for one ACP tool lifecycle event. */
export function presentDesktopToolEvent(update: ToolStart | ToolUpdate, previous?: DesktopToolPresentation): DesktopToolPresentation {
  if (update.phase === "start") {
    const entry = entryFor(update);
    const input = entry.input(update);
    return {
      toolCallId: update.toolCallId,
      title: update.title,
      toolKind: update.toolKind,
      cardKind: entry.cardKind,
      label: entry.label,
      status: update.status,
      summary: entry.summary(update),
      ...(input ? { input } : {}),
    };
  }

  if (previous && previous.toolCallId === update.toolCallId) {
    const entry = TOOL_PRESENTATION_REGISTRY.find((candidate) => candidate.cardKind === previous.cardKind) ?? TOOL_PRESENTATION_REGISTRY[TOOL_PRESENTATION_REGISTRY.length - 1]!;
    const output = entry.output(update.rawOutput);
    const artifacts = mergeDesktopArtifactEvidence(previous.artifacts, projectDesktopArtifactEvidence({
      toolCallId: update.toolCallId,
      content: update.content,
      locations: update.locations,
      meta: update.meta,
    }, previous.toolKind));
    return { ...previous, status: update.status, ...(output ? { output } : {}), ...(artifacts.length ? { artifacts } : {}) };
  }

  const output = block("Output", update.rawOutput, "text");
  const artifacts = projectDesktopArtifactEvidence({
    toolCallId: update.toolCallId,
    content: update.content,
    locations: update.locations,
    meta: update.meta,
  });
  return {
    toolCallId: update.toolCallId,
    title: "Tool result",
    toolKind: "other",
    cardKind: "generic",
    label: "Tool",
    status: update.status,
    summary: compactLine(output?.text ?? "", "Result without matching call metadata"),
    ...(output ? { output } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
}

/** Project assistant/reasoning chunks into stable message presentation intent without parsing Markdown yet. */
export function presentDesktopMessage(update: MessageUpdate): DesktopMessagePresentation {
  return update.kind === "reasoning"
    ? { kind: "reasoning", label: "Reasoning", text: update.text }
    : { kind: "markdown", label: "Assistant", text: update.text };
}
