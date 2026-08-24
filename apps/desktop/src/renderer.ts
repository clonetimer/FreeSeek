import type { DesktopEvent, DesktopExtensionManagedStatus, DesktopExtensionSnapshot, DesktopMcpServerInput, DesktopSessionListResult, DesktopStartRequest, FreeSeekDesktopApi } from "./contracts";
import { groupDesktopArtifactEvidence, type DesktopArtifactEvidence, type DesktopArtifactGroup } from "./artifact-evidence";
import { projectDesktopSessionUpdate } from "./presentation";
import { presentDesktopMessage, presentDesktopToolEvent, type DesktopPresentationBlock, type DesktopToolPresentation } from "./presentation-registry";
import { completeDesktopHostRequest, desktopTrajectorySearchText, matchesDesktopTrajectoryFilter, projectDesktopHostRequest, type DesktopInteractionPresentation, type DesktopTrajectoryFilterKind, type DesktopTrajectoryKind } from "./trajectory";
import { IncrementalMarkdownRenderer, IncrementalTextRenderer } from "./desktop-markdown";
import { boundedTextPreview, boundedUnknownText, boundedWindow, DESKTOP_UI_BUDGETS, fullUnknownText } from "./ui-performance";

declare global { interface Window { freesekDesktop: FreeSeekDesktopApi; } }

const api = window.freesekDesktop;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const workspace = $("workspace") as HTMLInputElement;
const baseUrl = $("baseUrl") as HTMLInputElement;
const apiKey = $("apiKey") as HTMLInputElement;
const model = $("model") as HTMLInputElement;
const format = $("format") as HTMLSelectElement;
const toolMode = $("toolMode") as HTMLSelectElement;
const authType = $("authType") as HTMLSelectElement;
const allowShell = $("allowShell") as HTMLInputElement;
const allowNetwork = $("allowNetwork") as HTMLInputElement;
const enableSkills = $("enableSkills") as HTMLInputElement;
const enableMultiAgent = $("enableMultiAgent") as HTMLInputElement;
const additionalDirectories = $("additionalDirectories") as HTMLTextAreaElement;
const skillDirs = $("skillDirs") as HTMLTextAreaElement;
const extensionDirs = $("extensionDirs") as HTMLTextAreaElement;
const extensionSandboxPolicyFile = $("extensionSandboxPolicyFile") as HTMLInputElement;
const mcpServers = $("mcpServers") as HTMLTextAreaElement;
const startButton = $("start") as HTMLButtonElement;
const chooseButton = $("chooseWorkspace") as HTMLButtonElement;
const saveSettingsButton = $("saveSettings") as HTMLButtonElement;
const forgetSecretButton = $("forgetSecret") as HTMLButtonElement;
const secretStatus = $("secretStatus");
const refreshHistoryButton = $("refreshHistory") as HTMLButtonElement;
const historySearch = $("historySearch") as HTMLInputElement;
const historyList = $("historyList") as HTMLSelectElement;
const resumeButton = $("resumeSession") as HTMLButtonElement;
const composer = $("composer") as HTMLTextAreaElement;
const sendButton = $("send") as HTMLButtonElement;
const stopButton = $("stop") as HTMLButtonElement;
const mode = $("mode") as HTMLSelectElement;
const closeSessionButton = $("closeSession") as HTMLButtonElement;
const messages = $("messages");
const conversationWindowControls = $("conversationWindowControls");
const conversationPrev = $("conversationPrev") as HTMLButtonElement;
const conversationNext = $("conversationNext") as HTMLButtonElement;
const conversationLatest = $("conversationLatest") as HTMLButtonElement;
const conversationWindowInfo = $("conversationWindowInfo");
const status = $("status");
const workarea = $("workarea");
const detailsPane = $("detailsPane");
const detailsToggle = $("detailsToggle") as HTMLButtonElement;
const trajectoryTab = $("trajectoryTab") as HTMLButtonElement;
const artifactTab = $("artifactTab") as HTMLButtonElement;
const extensionsTab = $("extensionsTab") as HTMLButtonElement;
const trajectoryPanel = $("trajectoryPanel");
const artifactPanel = $("artifactPanel");
const extensionsPanel = $("extensionsPanel");
const extensionsCount = $("extensionsCount");
const extensionRoots = $("extensionRoots");
const extensionsList = $("extensionsList");
const extensionDetail = $("extensionDetail");
const extensionsRefresh = $("extensionsRefresh") as HTMLButtonElement;
const extensionsReconcile = $("extensionsReconcile") as HTMLButtonElement;
const trajectoryList = $("trajectoryList");
const trajectoryPrev = $("trajectoryPrev") as HTMLButtonElement;
const trajectoryNext = $("trajectoryNext") as HTMLButtonElement;
const trajectoryLatest = $("trajectoryLatest") as HTMLButtonElement;
const trajectoryWindowInfo = $("trajectoryWindowInfo");
const trajectoryCount = $("trajectoryCount");
const trajectorySearch = $("trajectorySearch") as HTMLInputElement;
const trajectoryFilter = $("trajectoryFilter") as HTMLSelectElement;
const trajectoryDetail = $("trajectoryDetail");
const artifactPath = $("artifactPath") as HTMLInputElement;
const artifactCount = $("artifactCount");
const artifactDeliverables = $("artifactDeliverables");
const artifactEvidenceList = $("artifactEvidenceList");
const artifactEvidenceDetail = $("artifactEvidenceDetail");
const previewArtifactButton = $("previewArtifact") as HTMLButtonElement;
const openArtifactButton = $("openArtifact") as HTMLButtonElement;
const artifactMeta = $("artifactMeta");
const artifactPreview = $("artifactPreview");
const recoveryBanner = $("recoveryBanner");
const recoveryText = $("recoveryText");
const recoverSessionButton = $("recoverSession") as HTMLButtonElement;
const dismissRecoveryButton = $("dismissRecovery") as HTMLButtonElement;
const hostDialog = $("hostDialog");
const hostDialogTitle = $("hostDialogTitle");
const hostDialogMessage = $("hostDialogMessage");
const hostDialogDetail = $("hostDialogDetail");
const hostDialogField = $("hostDialogField");
const hostDialogActions = $("hostDialogActions");
const hostDialogCancel = $("hostDialogCancel") as HTMLButtonElement;
let sessionId = "";
let assistantBubble: HTMLElement | null = null;
let reasoningBubble: HTMLElement | null = null;
let assistantStream: IncrementalMarkdownRenderer | null = null;
let reasoningStream: IncrementalTextRenderer | null = null;
let assistantTrajectory: TrajectoryView | null = null;
let reasoningTrajectory: TrajectoryView | null = null;
let historyCache: DesktopSessionListResult = { sessions: [] };
interface ToolCardView {
  root: HTMLDetailsElement;
  name: HTMLElement;
  summary: HTMLElement;
  status: HTMLElement;
  blocks: HTMLElement;
  inspect: HTMLButtonElement;
}

const toolCards = new Map<string, ToolCardView>();
const toolPresentations = new Map<string, DesktopToolPresentation>();
const artifactEvidence = new Map<string, DesktopArtifactEvidence>();
const toolTrajectory = new Map<string, TrajectoryView>();
const interactionTrajectory = new Map<string, { presentation: DesktopInteractionPresentation; view: TrajectoryView }>();
const trajectoryViews: TrajectoryView[] = [];
const conversationNodes: HTMLElement[] = [];
let conversationWindowStart = 0;
let conversationRenderFrame: number | null = null;
let trajectoryWindowStart = 0;
let trajectoryRenderFrame: number | null = null;
let mountedTrajectoryViews: TrajectoryView[] = [];
let trajectorySequence = 0;
let selectedTrajectoryId = "";
let activeTurnNumber = 0;
let activeTurn: TrajectoryView | null = null;
let replayingHistory = false;
let selectedArtifactPath = "";

interface TrajectoryView {
  id: string;
  kind: DesktopTrajectoryKind;
  turn?: number;
  title: string;
  subtitle: string;
  status: string;
  badge: string;
  detail: unknown;
  searchText: string;
  row?: HTMLButtonElement;
  toolPresentation?: DesktopToolPresentation;
  conversationTarget?: HTMLElement;
}

function setStatus(text: string): void { status.textContent = text || "Ready"; }
function reducedMotion(): boolean { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; }
function artifactEvidenceKey(row: DesktopArtifactEvidence): string { return `${row.toolCallId}\u0000${row.id}`; }
function artifactStats(row: DesktopArtifactEvidence): string {
  const parts: string[] = [];
  if (typeof row.added === "number") parts.push(`+${row.added}`);
  if (typeof row.removed === "number") parts.push(`-${row.removed}`);
  return parts.join(" ");
}
function artifactKindLabel(kind: DesktopArtifactEvidence["kind"]): string {
  return ({ read: "Read", create: "Create", write: "Write", edit: "Edit", delete: "Delete", change: "Change" })[kind];
}
function appendDeferredString(target: HTMLElement, text: string, cap: number, className: string): void {
  const preview = boundedTextPreview(text, cap);
  const content = document.createElement("pre"); content.className = className; content.textContent = preview.text; target.append(content);
  if (!preview.truncated) return;
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "large-output-toggle"; toggle.setAttribute("aria-expanded", "false");
  const collapsed = `Show full · ${text.length.toLocaleString()} chars`; const expanded = "Collapse large output"; toggle.textContent = collapsed;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open)); content.textContent = open ? preview.text : text; toggle.textContent = open ? collapsed : expanded;
  });
  target.append(toggle);
}
function appendDeferredUnknown(target: HTMLElement, value: unknown, cap: number, className: string): void {
  const preview = boundedUnknownText(value, cap);
  const content = document.createElement("pre"); content.className = className; content.textContent = preview.text; target.append(content);
  if (!preview.truncated) return;
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "large-output-toggle"; toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "Show full detail";
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true"; toggle.setAttribute("aria-expanded", String(!open));
    content.textContent = open ? preview.text : fullUnknownText(value); toggle.textContent = open ? "Show full detail" : "Collapse detail";
  });
  target.append(toggle);
}
function conversationEntryFor(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>(".message, .tool-card");
}
function renderConversationWindow(anchorIndex?: number): void {
  if (!conversationNodes.length) {
    const empty = document.createElement("div"); empty.className = "empty"; const heading = document.createElement("h2"); heading.textContent = "Standalone FreeSeek"; const copy = document.createElement("p"); copy.textContent = "选择工作区和 Provider。Desktop 只负责宿主交互，通过 ACP sidecar 复用 Stable Kernel。"; empty.append(heading, copy); messages.replaceChildren(empty); conversationWindowControls.classList.add("hidden"); return;
  }
  const windowed = boundedWindow(conversationNodes.length, conversationWindowStart, DESKTOP_UI_BUDGETS.conversationWindow, anchorIndex); conversationWindowStart = windowed.start;
  messages.replaceChildren(...conversationNodes.slice(windowed.start, windowed.end));
  const bounded = conversationNodes.length > DESKTOP_UI_BUDGETS.conversationWindow; conversationWindowControls.classList.toggle("hidden", !bounded);
  conversationWindowInfo.textContent = `${windowed.start + 1}–${windowed.end} / ${conversationNodes.length}`;
  conversationPrev.disabled = windowed.start === 0; conversationNext.disabled = windowed.end >= conversationNodes.length; conversationLatest.disabled = windowed.end >= conversationNodes.length;
}
function scheduleConversationWindow(scrollToEnd = false): void {
  if (conversationRenderFrame !== null) return;
  conversationRenderFrame = window.requestAnimationFrame(() => { conversationRenderFrame = null; renderConversationWindow(); if (scrollToEnd) messages.scrollTop = messages.scrollHeight; });
}
function appendConversationNode(node: HTMLElement): void {
  conversationNodes.push(node); conversationWindowStart = Math.max(0, conversationNodes.length - DESKTOP_UI_BUDGETS.conversationWindow); scheduleConversationWindow(true);
}
function ensureConversationTargetVisible(target: HTMLElement): void {
  const entry = conversationEntryFor(target); if (!entry) return; const index = conversationNodes.indexOf(entry); if (index < 0) return; renderConversationWindow(index);
}
function inspectToolInTrajectory(toolCallId: string): void {
  const trajectory = toolTrajectory.get(toolCallId);
  if (!trajectory) return;
  ensureDetailsVisible(); activateDetailsTab("trajectory"); trajectorySearch.value = ""; trajectoryFilter.value = "all"; selectedTrajectoryId = trajectory.id;
  const index = trajectoryViews.indexOf(trajectory); trajectoryWindowStart = boundedWindow(trajectoryViews.length, trajectoryWindowStart, DESKTOP_UI_BUDGETS.trajectoryWindow, index).start; renderTrajectoryWindow();
  selectTrajectory(trajectory); trajectory.row?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }); trajectory.row?.focus({ preventScroll: true });
}
function renderArtifactGroupDetail(group: DesktopArtifactGroup, preferred?: DesktopArtifactEvidence, showAll = false): void {
  selectedArtifactPath = group.path;
  artifactPath.value = group.path;
  artifactEvidenceDetail.replaceChildren();
  const header = document.createElement("div"); header.className = "artifact-detail-header";
  const title = document.createElement("strong"); title.textContent = group.file;
  const summary = document.createElement("span"); summary.textContent = `${group.mutationCount} change${group.mutationCount === 1 ? "" : "s"} · ${group.referenceCount} read${group.referenceCount === 1 ? "" : "s"}`;
  header.append(title, summary); artifactEvidenceDetail.append(header);
  const pathCopy = document.createElement("div"); pathCopy.className = "artifact-evidence-copy"; pathCopy.textContent = group.path; artifactEvidenceDetail.append(pathCopy);
  const evidenceCap = 40; let visibleEvidence = showAll || group.evidence.length <= evidenceCap ? group.evidence : group.evidence.slice(-evidenceCap);
  if (preferred && !visibleEvidence.includes(preferred)) visibleEvidence = [preferred, ...visibleEvidence];
  if (!showAll && group.evidence.length > visibleEvidence.length) {
    const note = document.createElement("div"); note.className = "artifact-evidence-copy"; note.textContent = `${group.evidence.length - visibleEvidence.length} older evidence row(s) are deferred.`;
    const show = document.createElement("button"); show.type = "button"; show.className = "large-output-toggle"; show.textContent = `Show all ${group.evidence.length} evidence rows`; show.addEventListener("click", () => renderArtifactGroupDetail(group, preferred, true)); artifactEvidenceDetail.append(note, show);
  }

  for (let index = 0; index < visibleEvidence.length; index++) {
    const row = visibleEvidence[index]!;
    const entry = document.createElement("details"); entry.className = "artifact-evidence-entry";
    if (row === preferred || (!preferred && index === visibleEvidence.length - 1)) entry.open = true;
    const line = document.createElement("summary");
    const stats = artifactStats(row); line.textContent = `${artifactKindLabel(row.kind)}${row.deliverable ? " · produced" : ""}${stats ? ` · ${stats}` : ""}`;
    entry.append(line);
    const provenance = document.createElement("div"); provenance.className = "artifact-evidence-copy";
    provenance.textContent = `ACP tool ${row.toolCallId}${row.diffAvailable ? " · structured diff projected" : row.kind === "delete" ? " · deletion evidence only; no complete pre-delete snapshot" : " · file location evidence"}`;
    entry.append(provenance);
    if (row.diff) {
      const beforeLabel = document.createElement("div"); beforeLabel.className = "artifact-diff-label"; beforeLabel.textContent = "Before"; entry.append(beforeLabel);
      appendDeferredString(entry, row.diff.oldText === null ? "(new file)" : row.diff.oldText, DESKTOP_UI_BUDGETS.artifactDiffPreviewChars, "artifact-diff-text");
      const afterLabel = document.createElement("div"); afterLabel.className = "artifact-diff-label"; afterLabel.textContent = "After"; entry.append(afterLabel);
      appendDeferredString(entry, row.diff.newText, DESKTOP_UI_BUDGETS.artifactDiffPreviewChars, "artifact-diff-text");
    }
    const actions = document.createElement("div"); actions.className = "artifact-evidence-actions";
    const inspect = document.createElement("button"); inspect.type = "button"; inspect.textContent = "Inspect tool"; inspect.addEventListener("click", () => inspectToolInTrajectory(row.toolCallId));
    actions.append(inspect); entry.append(actions); artifactEvidenceDetail.append(entry);
  }
}
function selectArtifactEvidence(row: DesktopArtifactEvidence): void {
  const group = groupDesktopArtifactEvidence([...artifactEvidence.values()]).find((candidate) => candidate.path === row.path);
  if (!group) return;
  ensureDetailsVisible(); activateDetailsTab("artifact"); renderArtifactGroupDetail(group, row); renderArtifactEvidenceIndex();
}
function renderArtifactEvidenceIndex(): void {
  const rows = [...artifactEvidence.values()];
  const groups = groupDesktopArtifactEvidence(rows);
  artifactCount.textContent = `${groups.length} file${groups.length === 1 ? "" : "s"} · ${rows.length} evidence`;

  artifactDeliverables.replaceChildren();
  const deliverableGroups = groups.filter((group) => group.deliverable);
  if (!deliverableGroups.length) {
    const empty = document.createElement("span"); empty.className = "artifact-empty"; empty.textContent = "No produced files projected yet."; artifactDeliverables.append(empty);
  } else {
    for (const group of deliverableGroups) {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = "artifact-chip"; chip.textContent = group.file; chip.title = group.path;
      chip.addEventListener("click", () => {
        const produced = group.evidence.find((row) => row.deliverable);
        ensureDetailsVisible(); activateDetailsTab("artifact"); renderArtifactGroupDetail(group, produced); renderArtifactEvidenceIndex();
      });
      artifactDeliverables.append(chip);
    }
  }

  artifactEvidenceList.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("div"); empty.className = "artifact-empty"; empty.textContent = "Successful file-tool evidence will appear here."; artifactEvidenceList.append(empty);
    artifactEvidenceDetail.textContent = "Select an evidence-backed file to inspect its projected lifecycle and structured diff.";
    return;
  }
  for (const group of groups) {
    const button = document.createElement("button"); button.type = "button"; button.className = "artifact-file-row";
    if (group.path === selectedArtifactPath) button.classList.add("selected");
    const name = document.createElement("span"); name.className = "artifact-file-name"; name.textContent = group.file;
    const badges = document.createElement("span"); badges.className = "artifact-file-badges";
    if (group.deliverable) { const badge = document.createElement("span"); badge.className = "artifact-badge output"; badge.textContent = "output"; badges.append(badge); }
    if (group.mutationCount) { const badge = document.createElement("span"); badge.className = "artifact-badge change"; badge.textContent = `${group.mutationCount} change${group.mutationCount === 1 ? "" : "s"}`; badges.append(badge); }
    if (group.referenceCount) { const badge = document.createElement("span"); badge.className = "artifact-badge read"; badge.textContent = `${group.referenceCount} read${group.referenceCount === 1 ? "" : "s"}`; badges.append(badge); }
    const pathCopy = document.createElement("span"); pathCopy.className = "artifact-file-path"; pathCopy.textContent = group.path;
    button.append(name, badges, pathCopy); button.addEventListener("click", () => { renderArtifactGroupDetail(group); renderArtifactEvidenceIndex(); }); artifactEvidenceList.append(button);
  }
}
function registerToolArtifactEvidence(presentation: DesktopToolPresentation): void {
  let changed = false;
  for (const row of presentation.artifacts ?? []) {
    const key = artifactEvidenceKey(row);
    if (artifactEvidence.get(key) !== row) { artifactEvidence.set(key, row); changed = true; }
  }
  if (changed) renderArtifactEvidenceIndex();
}
function appendPresentationBlock(target: HTMLElement, block: DesktopPresentationBlock): void {
  const section = document.createElement("section"); section.className = "tool-block"; section.dataset.blockKind = block.kind;
  const heading = document.createElement("div"); heading.className = "tool-block-heading"; heading.textContent = block.language ? `${block.label} · ${block.language}` : block.label; section.append(heading);
  if (block.source !== undefined) appendDeferredUnknown(section, block.source, DESKTOP_UI_BUDGETS.toolBlockPreviewChars, "tool-block-content");
  else appendDeferredString(section, block.text, DESKTOP_UI_BUDGETS.toolBlockPreviewChars, "tool-block-content"); target.append(section);
}
function renderToolPresentationBlocks(target: HTMLElement, presentation: DesktopToolPresentation): void {
  target.replaceChildren();
  if (presentation.input) appendPresentationBlock(target, presentation.input);
  if (presentation.output) appendPresentationBlock(target, presentation.output);
  if (presentation.artifacts?.length) {
    const evidence = document.createElement("div"); evidence.className = "tool-artifact-evidence";
    const label = document.createElement("div"); label.className = "tool-artifact-evidence-label"; label.textContent = "File evidence"; evidence.append(label);
    for (const row of presentation.artifacts) {
      const button = document.createElement("button"); button.type = "button"; button.title = row.path;
      const stats = artifactStats(row); button.textContent = `${artifactKindLabel(row.kind)} · ${row.file}${row.deliverable ? " · output" : ""}${stats ? ` · ${stats}` : ""}`;
      button.addEventListener("click", () => selectArtifactEvidence(row)); evidence.append(button);
    }
    target.append(evidence);
  }
  if (!presentation.input && !presentation.output && !presentation.artifacts?.length) {
    const empty = document.createElement("div"); empty.className = "tool-block-empty"; empty.textContent = "No structured input/output was projected by ACP."; target.append(empty);
  }
}
function ensureDetailsVisible(): void {
  if (workarea.classList.contains("details-collapsed")) {
    workarea.classList.remove("details-collapsed");
    detailsPane.setAttribute("aria-hidden", "false");
    detailsToggle.setAttribute("aria-expanded", "true");
    detailsToggle.textContent = "Details";
  }
}
function trajectorySearchRecord(view: TrajectoryView) {
  return {
    kind: view.kind,
    title: view.title,
    subtitle: view.subtitle,
    status: view.status,
    ...(view.turn ? { turn: view.turn } : {}),
    detail: view.toolPresentation ?? view.detail,
    searchText: view.searchText,
  };
}
function rebuildTrajectorySearchIndex(view: TrajectoryView): void {
  const record = trajectorySearchRecord(view);
  view.searchText = desktopTrajectorySearchText({ ...record, searchText: undefined });
}
function matchingTrajectoryViews(): TrajectoryView[] {
  const filter = trajectoryFilter.value as DesktopTrajectoryFilterKind;
  const query = trajectorySearch.value;
  return trajectoryViews.filter((view) => matchesDesktopTrajectoryFilter(trajectorySearchRecord(view), filter, query));
}
function updateTrajectoryCount(matches = matchingTrajectoryViews()): void {
  const total = trajectoryViews.length;
  trajectoryCount.textContent = matches.length === total ? `${total} event${total === 1 ? "" : "s"}` : `${matches.length}/${total} events`;
}
function syncTrajectoryRow(view: TrajectoryView): void {
  const row = view.row; if (!row) return;
  const title = row.querySelector<HTMLElement>(".trajectory-title"); const subtitle = row.querySelector<HTMLElement>(".trajectory-subtitle"); const state = row.querySelector<HTMLElement>(".trajectory-status");
  if (title) title.textContent = view.title; if (subtitle) subtitle.textContent = view.subtitle;
  if (state) { state.textContent = view.status; state.className = "trajectory-status"; if (view.status) state.classList.add(view.status); }
  const selected = selectedTrajectoryId === view.id; row.classList.toggle("selected", selected); row.setAttribute("aria-selected", String(selected)); row.tabIndex = selected ? 0 : -1;
}
function focusTrajectoryAt(matches: TrajectoryView[], index: number): void {
  const next = matches[Math.min(Math.max(0, index), matches.length - 1)]; if (!next) return;
  trajectoryWindowStart = boundedWindow(matches.length, trajectoryWindowStart, DESKTOP_UI_BUDGETS.trajectoryWindow, matches.indexOf(next)).start; renderTrajectoryWindow(next); selectTrajectory(next); next.row?.focus();
}
function focusTrajectoryNeighbor(view: TrajectoryView, direction: -1 | 1): void {
  const matches = matchingTrajectoryViews(); const index = matches.indexOf(view); if (index < 0) return; focusTrajectoryAt(matches, index + direction);
}
function createTrajectoryRow(view: TrajectoryView): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = "trajectory-item"; button.setAttribute("role", "option");
  const kindBadge = document.createElement("span"); kindBadge.className = "trajectory-kind"; kindBadge.textContent = view.badge.slice(0, 4);
  const copy = document.createElement("span"); copy.className = "trajectory-copy";
  const title = document.createElement("span"); title.className = "trajectory-title";
  const subtitle = document.createElement("span"); subtitle.className = "trajectory-subtitle";
  const state = document.createElement("span"); state.className = "trajectory-status"; copy.append(title, subtitle); button.append(kindBadge, copy, state);
  button.dataset.trajectoryId = view.id; button.dataset.trajectoryKind = view.kind; if (view.turn) button.dataset.turn = String(view.turn);
  button.addEventListener("click", () => selectTrajectory(view));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); focusTrajectoryNeighbor(view, 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusTrajectoryNeighbor(view, -1); }
    else if (event.key === "Home") { event.preventDefault(); focusTrajectoryAt(matchingTrajectoryViews(), 0); }
    else if (event.key === "End") { event.preventDefault(); const matches = matchingTrajectoryViews(); focusTrajectoryAt(matches, matches.length - 1); }
  });
  view.row = button; syncTrajectoryRow(view); return button;
}
function renderTrajectoryWindow(anchor?: TrajectoryView): void {
  for (const view of mountedTrajectoryViews) view.row = undefined; mountedTrajectoryViews = [];
  const matches = matchingTrajectoryViews(); updateTrajectoryCount(matches);
  if (!matches.length) {
    const empty = document.createElement("div"); empty.className = "trajectory-empty"; empty.textContent = trajectoryViews.length ? "No trajectory events match the current filter." : "Turns, reasoning, tool calls, mode changes and host interactions will appear here."; trajectoryList.replaceChildren(empty);
    trajectoryWindowInfo.textContent = `0 / ${trajectoryViews.length}`; trajectoryPrev.disabled = true; trajectoryNext.disabled = true; trajectoryLatest.disabled = true; return;
  }
  const anchorIndex = anchor ? matches.indexOf(anchor) : selectedTrajectoryId ? matches.findIndex((view) => view.id === selectedTrajectoryId) : -1;
  const windowed = boundedWindow(matches.length, trajectoryWindowStart, DESKTOP_UI_BUDGETS.trajectoryWindow, anchorIndex >= 0 ? anchorIndex : undefined); trajectoryWindowStart = windowed.start;
  mountedTrajectoryViews = matches.slice(windowed.start, windowed.end); trajectoryList.replaceChildren(...mountedTrajectoryViews.map(createTrajectoryRow));
  const selectedMounted = mountedTrajectoryViews.some((view) => view.id === selectedTrajectoryId); if (!selectedMounted && mountedTrajectoryViews[0]?.row) mountedTrajectoryViews[0].row.tabIndex = 0;
  trajectoryWindowInfo.textContent = `${windowed.start + 1}–${windowed.end} / ${matches.length}`; trajectoryPrev.disabled = windowed.start === 0; trajectoryNext.disabled = windowed.end >= matches.length; trajectoryLatest.disabled = windowed.end >= matches.length;
}
function scheduleTrajectoryWindow(anchor?: TrajectoryView): void {
  if (trajectoryRenderFrame !== null) return;
  trajectoryRenderFrame = window.requestAnimationFrame(() => { trajectoryRenderFrame = null; renderTrajectoryWindow(anchor); });
}
function applyTrajectoryFilters(resetWindow = true): void {
  const matches = matchingTrajectoryViews();
  if (resetWindow) trajectoryWindowStart = Math.max(0, matches.length - DESKTOP_UI_BUDGETS.trajectoryWindow);
  const selected = trajectoryViews.find((view) => view.id === selectedTrajectoryId);
  if (selected && !matches.includes(selected)) trajectoryDetail.textContent = "The selected event is hidden by the current trajectory filter.";
  renderTrajectoryWindow();
}
function jumpToConversation(view: TrajectoryView): void {
  const target = view.conversationTarget; if (!target) return; ensureConversationTargetVisible(target);
  target.tabIndex = -1; target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" }); target.focus({ preventScroll: true });
  target.classList.add("navigation-target"); window.setTimeout(() => target.classList.remove("navigation-target"), reducedMotion() ? 0 : 900);
}
function renderTrajectoryNavigation(view: TrajectoryView, target: HTMLElement): void {
  if (!view.conversationTarget) return;
  const actions = document.createElement("div"); actions.className = "trajectory-detail-actions";
  const jump = document.createElement("button"); jump.type = "button"; jump.textContent = view.kind === "tool" ? "Jump to tool card" : "Jump to conversation";
  jump.addEventListener("click", () => jumpToConversation(view)); actions.append(jump); target.append(actions);
}
function renderToolTrajectoryDetail(view: TrajectoryView, presentation: DesktopToolPresentation): void {
  trajectoryDetail.replaceChildren();
  const header = document.createElement("div"); header.className = "trajectory-tool-header";
  const title = document.createElement("strong"); title.textContent = `${presentation.label} · ${presentation.title}`;
  const state = document.createElement("span"); state.className = `trajectory-status ${presentation.status}`; state.textContent = presentation.status;
  const summary = document.createElement("div"); summary.className = "trajectory-tool-summary"; summary.textContent = presentation.summary;
  header.append(title, state, summary); trajectoryDetail.append(header); renderTrajectoryNavigation(view, trajectoryDetail);
  const body = document.createElement("div"); body.className = "trajectory-tool-body"; renderToolPresentationBlocks(body, presentation); trajectoryDetail.append(body);
}
function renderGenericTrajectoryDetail(view: TrajectoryView): void {
  trajectoryDetail.replaceChildren();
  const meta = document.createElement("div"); meta.className = "trajectory-detail-meta"; meta.textContent = `${view.kind}${view.turn ? ` · Turn ${view.turn}` : ""}${view.status ? ` · ${view.status}` : ""}`;
  trajectoryDetail.append(meta); renderTrajectoryNavigation(view, trajectoryDetail); appendDeferredUnknown(trajectoryDetail, view.detail, DESKTOP_UI_BUDGETS.trajectoryDetailPreviewChars, "trajectory-detail-content");
}
function renderToolCard(view: ToolCardView, presentation: DesktopToolPresentation): void {
  view.root.dataset.toolKind = presentation.toolKind; view.root.dataset.cardKind = presentation.cardKind;
  view.name.textContent = `${presentation.label} · ${presentation.title}`; view.summary.textContent = presentation.summary;
  view.status.textContent = presentation.status; view.status.className = `tool-status ${presentation.status}`; renderToolPresentationBlocks(view.blocks, presentation);
}
function createToolCard(presentation: DesktopToolPresentation): ToolCardView {
  const root = document.createElement("details"); root.className = "tool-card"; root.dataset.toolCallId = presentation.toolCallId;
  const disclosure = document.createElement("summary"); disclosure.className = "tool-title";
  const family = document.createElement("span"); family.className = "tool-family"; family.textContent = presentation.label.slice(0, 3).toUpperCase();
  const copy = document.createElement("span"); copy.className = "tool-title-copy"; const name = document.createElement("span"); name.className = "tool-name"; const summary = document.createElement("span"); summary.className = "tool-summary"; copy.append(name, summary);
  const state = document.createElement("span"); state.className = "tool-status"; const body = document.createElement("div"); body.className = "tool-card-body"; const blocks = document.createElement("div"); blocks.className = "tool-card-blocks";
  const actions = document.createElement("div"); actions.className = "tool-card-actions"; const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "tool-inspect"; inspect.textContent = "Inspect in trajectory"; inspect.addEventListener("click", () => inspectToolInTrajectory(presentation.toolCallId));
  actions.append(inspect); body.append(blocks, actions); disclosure.append(family, copy, state); root.append(disclosure, body); const view = { root, name, summary, status: state, blocks, inspect }; renderToolCard(view, presentation); return view;
}
function selectTrajectory(view: TrajectoryView): void {
  selectedTrajectoryId = view.id; for (const mounted of mountedTrajectoryViews) syncTrajectoryRow(mounted);
  if (view.toolPresentation) renderToolTrajectoryDetail(view, view.toolPresentation); else renderGenericTrajectoryDetail(view);
}
function refreshTrajectoryView(view: TrajectoryView): void {
  rebuildTrajectorySearchIndex(view); syncTrajectoryRow(view); if (selectedTrajectoryId === view.id) selectTrajectory(view);
  if (trajectorySearch.value.trim()) scheduleTrajectoryWindow(view); else updateTrajectoryCount();
}
function addTrajectory(
  kind: DesktopTrajectoryKind,
  titleText: string,
  subtitleText: string,
  detail: unknown,
  statusText = "",
  options: { badge?: string; turn?: number; conversationTarget?: HTMLElement; toolPresentation?: DesktopToolPresentation } = {}
): TrajectoryView {
  const view: TrajectoryView = {
    id: `trajectory-${++trajectorySequence}`,
    kind,
    title: titleText,
    subtitle: subtitleText,
    status: statusText,
    badge: options.badge ?? kind,
    ...(options.turn ? { turn: options.turn } : {}),
    detail,
    searchText: "",
    ...(options.toolPresentation ? { toolPresentation: options.toolPresentation } : {}),
    ...(options.conversationTarget ? { conversationTarget: options.conversationTarget } : {}),
  };
  rebuildTrajectorySearchIndex(view); trajectoryViews.push(view);
  if (trajectoryFilter.value === "all" && !trajectorySearch.value.trim()) trajectoryWindowStart = Math.max(0, trajectoryViews.length - DESKTOP_UI_BUDGETS.trajectoryWindow);
  scheduleTrajectoryWindow(); return view;
}
function finishActiveTurn(statusText: "completed" | "failed" | "cancelled" = "completed"): void {
  if (!activeTurn) return; activeTurn.status = statusText; refreshTrajectoryView(activeTurn); activeTurn = null;
}
function beginTurn(promptText: string, conversationTarget: HTMLElement, lifecycle: "in_progress" | "history" = "in_progress"): TrajectoryView {
  if (activeTurn?.status === "in_progress") finishActiveTurn("completed"); else activeTurn = null;
  const turn = ++activeTurnNumber;
  activeTurn = addTrajectory("turn", `Turn ${turn}`, promptText.slice(0, 120), { turn, prompt: promptText }, lifecycle, { badge: `T${turn}`, turn, conversationTarget });
  return activeTurn;
}
function finishCurrentStreams(): void {
  assistantStream?.finish(); reasoningStream?.finish(); assistantStream = null; reasoningStream = null; assistantBubble = null; reasoningBubble = null;
  if (reasoningTrajectory?.status === "in_progress") { reasoningTrajectory.status = "completed"; refreshTrajectoryView(reasoningTrajectory); }
  reasoningTrajectory = null; assistantTrajectory = null;
}
function resetPresentation(): void {
  finishCurrentStreams();
  if (conversationRenderFrame !== null) { window.cancelAnimationFrame(conversationRenderFrame); conversationRenderFrame = null; }
  if (trajectoryRenderFrame !== null) { window.cancelAnimationFrame(trajectoryRenderFrame); trajectoryRenderFrame = null; }
  messages.replaceChildren(); conversationNodes.splice(0); conversationWindowStart = 0; conversationWindowControls.classList.add("hidden");
  toolCards.clear(); toolPresentations.clear(); artifactEvidence.clear(); toolTrajectory.clear(); interactionTrajectory.clear(); trajectoryViews.splice(0); mountedTrajectoryViews = []; trajectoryWindowStart = 0; trajectorySequence = 0; selectedTrajectoryId = ""; activeTurnNumber = 0; activeTurn = null; replayingHistory = false; selectedArtifactPath = "";
  assistantTrajectory = null; reasoningTrajectory = null; trajectorySearch.value = ""; trajectoryFilter.value = "all";
  renderConversationWindow(); renderTrajectoryWindow(); trajectoryDetail.textContent = "Select a trajectory item to inspect its projected ACP/Host lifecycle.";
  artifactPath.value = ""; artifactMeta.textContent = "No artifact selected."; artifactPreview.textContent = ""; renderArtifactEvidenceIndex();
}
type DetailsTab = "trajectory" | "artifact" | "extensions";
function activateDetailsTab(tab: DetailsTab, focus = false): void {
  const tabs: Array<{ id: DetailsTab; button: HTMLButtonElement; panel: HTMLElement }> = [
    { id: "trajectory", button: trajectoryTab, panel: trajectoryPanel },
    { id: "artifact", button: artifactTab, panel: artifactPanel },
    { id: "extensions", button: extensionsTab, panel: extensionsPanel },
  ];
  for (const row of tabs) {
    const active = row.id === tab; row.button.classList.toggle("active", active); row.button.setAttribute("aria-selected", String(active)); row.button.tabIndex = active ? 0 : -1;
    row.panel.classList.toggle("hidden", !active); row.panel.setAttribute("aria-hidden", String(!active));
  }
  if (focus) tabs.find((row) => row.id === tab)?.button.focus();
  if (tab === "extensions") void refreshExtensions();
}
function pathLines(value: string): string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function parseMcpServers(): DesktopMcpServerInput[] {
  const raw = mcpServers.value.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("MCP stdio JSON must be an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`MCP[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name.trim() || typeof row.command !== "string" || !row.command.trim()) throw new Error(`MCP[${index}] requires name and command`);
    const args = row.args === undefined ? [] : Array.isArray(row.args) ? row.args.map(String) : (() => { throw new Error(`MCP[${index}].args must be an array`); })();
    const env = row.env === undefined ? undefined : Array.isArray(row.env) ? row.env.map((item, envIndex) => {
      if (!item || typeof item !== "object") throw new Error(`MCP[${index}].env[${envIndex}] must be an object`);
      const pair = item as Record<string, unknown>;
      if (typeof pair.name !== "string" || typeof pair.value !== "string") throw new Error(`MCP[${index}].env[${envIndex}] requires string name/value`);
      return { name: pair.name, value: pair.value };
    }) : (() => { throw new Error(`MCP[${index}].env must be an array`); })();
    return { name: row.name.trim(), command: row.command.trim(), args, ...(env ? { env } : {}) };
  });
}
function requestFromForm(): DesktopStartRequest {
  return {
    workspace: workspace.value.trim(),
    provider: {
      baseUrl: baseUrl.value.trim(), apiKey: apiKey.value, model: model.value.trim(),
      format: format.value as DesktopStartRequest["provider"]["format"],
      toolMode: toolMode.value as DesktopStartRequest["provider"]["toolMode"],
      authType: authType.value as DesktopStartRequest["provider"]["authType"],
    },
    allowShell: allowShell.checked,
    allowNetwork: allowNetwork.checked,
    enableSkills: enableSkills.checked,
    skillDirs: pathLines(skillDirs.value),
    extensionDirs: pathLines(extensionDirs.value),
    extensionSandboxPolicyFile: extensionSandboxPolicyFile.value.trim(),
    enableMultiAgent: enableMultiAgent.checked,
    additionalDirectories: pathLines(additionalDirectories.value),
    mcpServers: parseMcpServers(),
  };
}
function consumeRequestFromForm(): DesktopStartRequest {
  try { return requestFromForm(); }
  finally { apiKey.value = ""; }
}
function setSessionControls(active: boolean): void {
  composer.disabled = !active; sendButton.disabled = !active; mode.disabled = !active; closeSessionButton.disabled = !active;
  previewArtifactButton.disabled = !active; openArtifactButton.disabled = !active;
  refreshHistoryButton.disabled = active; historyList.disabled = active; resumeButton.disabled = active || !historyList.value;
}
function addMessage(role: "user" | "assistant" | "tool" | "system" | "reasoning", text: string): HTMLElement {
  const row = document.createElement("div"); row.className = `message ${role}`; row.setAttribute("role", "article"); row.setAttribute("aria-label", `${role} message`);
  const label = document.createElement("div"); label.className = "label"; label.textContent = role;
  const body = document.createElement("div"); body.className = "body"; body.textContent = text; row.append(label, body); appendConversationNode(row); return body;
}
function renderHistory(result: DesktopSessionListResult): void {
  historyCache = result; historyList.replaceChildren(); const query = historySearch.value.trim().toLowerCase();
  for (const row of result.sessions ?? []) {
    const haystack = `${row.sessionId} ${row.cwd} ${row.title ?? ""}`.toLowerCase(); if (query && !haystack.includes(query)) continue;
    const option = document.createElement("option"); option.value = row.sessionId;
    const title = row.title?.trim() || row.sessionId.slice(0, 18); const updated = row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "";
    option.textContent = updated ? `${title} · ${updated}` : title; option.title = `${row.sessionId}\n${row.cwd}`; historyList.append(option);
  }
  resumeButton.disabled = !historyList.value || Boolean(sessionId);
}
function applySettings(result: Awaited<ReturnType<FreeSeekDesktopApi["getSettings"]>>): void {
  const settings = result.settings;
  workspace.value = settings.workspace; baseUrl.value = settings.provider.baseUrl; model.value = settings.provider.model;
  format.value = settings.provider.format; toolMode.value = settings.provider.toolMode; authType.value = settings.provider.authType;
  allowShell.checked = settings.allowShell; allowNetwork.checked = settings.allowNetwork; enableSkills.checked = settings.enableSkills; enableMultiAgent.checked = settings.enableMultiAgent;
  additionalDirectories.value = settings.additionalDirectories.join("\n"); skillDirs.value = settings.skillDirs.join("\n"); extensionDirs.value = settings.extensionDirs.join("\n"); extensionSandboxPolicyFile.value = settings.extensionSandboxPolicyFile;
  mcpServers.value = settings.mcpServers.length ? JSON.stringify(settings.mcpServers, null, 2) : "";
  secretStatus.textContent = result.secret.stored ? `stored securely${result.secret.backend ? ` · ${result.secret.backend}` : ""}` : result.secret.secureStorage ? "not stored" : `secure storage unavailable${result.secret.backend ? ` · ${result.secret.backend}` : ""}`;
  apiKey.placeholder = result.secret.stored ? "Stored key will be used if left blank" : "One-time or save securely";
}

function extensionStateSummary(row: DesktopExtensionManagedStatus): string {
  const generation = row.runtime.activeGeneration ? `g${row.runtime.activeGeneration}` : row.runtime.pendingVersion ? `pending ${row.runtime.pendingVersion}` : row.runtime.state;
  const sandbox = row.runtime.sandbox ? ` · sandbox:${row.runtime.sandbox.state}` : "";
  return `${row.health} · ${row.packageVersion ?? row.runtime.activeVersion ?? "unknown"} · ${generation}${sandbox}`;
}

async function showExtensionDetail(row: DesktopExtensionManagedStatus): Promise<void> {
  extensionDetail.replaceChildren();
  const title = document.createElement("strong"); title.textContent = row.id; extensionDetail.append(title);
  const summary = document.createElement("div"); summary.className = "artifact-evidence-copy"; summary.textContent = extensionStateSummary(row); extensionDetail.append(summary);
  const paths = document.createElement("pre"); paths.className = "artifact-diff-text"; paths.textContent = row.packageDirs.length ? row.packageDirs.join("\n") : "No package currently observed in configured trust roots."; extensionDetail.append(paths);
  if (row.runtime.sandbox) { const sandbox = document.createElement("div"); sandbox.className = "artifact-evidence-copy"; sandbox.textContent = `Sandbox: ${row.runtime.sandbox.state} · ${row.runtime.sandbox.platform} · ${row.runtime.sandbox.isolation}${row.runtime.sandbox.pid ? ` · pid ${row.runtime.sandbox.pid}` : ""}`; extensionDetail.append(sandbox); }
  if (row.runtime.lastError) { const error = document.createElement("pre"); error.className = "artifact-diff-text"; error.textContent = `Last error: ${row.runtime.lastError}`; extensionDetail.append(error); }
  if (row.runtime.missingDependencies?.length) { const deps = document.createElement("div"); deps.className = "artifact-evidence-copy"; deps.textContent = `Missing dependencies: ${row.runtime.missingDependencies.join(", ")}`; extensionDetail.append(deps); }
  const actions = document.createElement("div"); actions.className = "artifact-evidence-actions";
  const reload = document.createElement("button"); reload.type = "button"; reload.textContent = "Reload"; reload.disabled = !row.enabled || row.conflict;
  reload.addEventListener("click", async () => { try { await api.reloadExtension(row.id); await refreshExtensions(row.id); } catch (error: any) { setStatus(error?.message ?? String(error)); } });
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.textContent = row.enabled ? "Disable" : "Enable";
  toggle.addEventListener("click", async () => { try { await api.configureExtension(row.id, !row.enabled); await refreshExtensions(row.id); } catch (error: any) { setStatus(error?.message ?? String(error)); } });
  actions.append(reload, toggle); extensionDetail.append(actions);
  try {
    const audit = await api.extensionAudit(row.id);
    const pre = document.createElement("pre"); pre.className = "artifact-diff-text"; pre.textContent = audit.events.length ? JSON.stringify(audit.events.slice(-20), null, 2) : "No durable audit events yet."; extensionDetail.append(pre);
  } catch (error: any) { const note = document.createElement("div"); note.className = "artifact-evidence-copy"; note.textContent = `Audit unavailable: ${error?.message ?? String(error)}`; extensionDetail.append(note); }
}

async function refreshExtensions(selectId?: string): Promise<void> {
  if (!api.listExtensions) return;
  try {
    const snapshot: DesktopExtensionSnapshot = await api.listExtensions();
    extensionsCount.textContent = `${snapshot.extensions.length} extension${snapshot.extensions.length === 1 ? "" : "s"}`;
    extensionRoots.textContent = snapshot.trustRoots.length ? `Trust roots: ${snapshot.trustRoots.join(" · ")}` : "No Extension trust roots configured.";
    extensionsList.replaceChildren();
    if (!snapshot.extensions.length) { const empty = document.createElement("div"); empty.className = "artifact-empty"; empty.textContent = "No Extension packages observed."; extensionsList.append(empty); extensionDetail.textContent = "No extension selected."; return; }
    for (const row of snapshot.extensions) {
      const button = document.createElement("button"); button.type = "button"; button.className = "artifact-evidence-row"; button.title = row.packageDirs.join("\n");
      const name = document.createElement("strong"); name.textContent = row.id; const detail = document.createElement("span"); detail.textContent = extensionStateSummary(row); button.append(name, detail);
      button.addEventListener("click", () => { void showExtensionDetail(row); }); extensionsList.append(button);
      if (selectId === row.id) void showExtensionDetail(row);
    }
  } catch (error: any) { extensionDetail.textContent = error?.message ?? String(error); }
}

chooseButton.addEventListener("click", async () => { const selected = await api.chooseWorkspace(); if (selected) workspace.value = selected; });
saveSettingsButton.addEventListener("click", async () => {
  saveSettingsButton.disabled = true;
  try { const result = await api.saveSettings(consumeRequestFromForm()); applySettings(result); setStatus("Desktop settings saved"); }
  catch (error: any) { setStatus(`Settings: ${error?.message ?? String(error)}`); }
  finally { saveSettingsButton.disabled = false; }
});
forgetSecretButton.addEventListener("click", async () => {
  const request = requestFromForm(); const { apiKey: _ignored, ...provider } = request.provider;
  await api.forgetProviderSecret(provider); apiKey.value = ""; applySettings(await api.getSettings()); setStatus("Stored provider key removed");
});
refreshHistoryButton.addEventListener("click", async () => {
  refreshHistoryButton.disabled = true; setStatus("Loading durable sessions…");
  try { const result = await api.loadHistory(consumeRequestFromForm()); renderHistory(result); setStatus(`${result.sessions.length} session(s) found`); }
  catch (error: any) { setStatus(error?.message ?? String(error)); }
  finally { refreshHistoryButton.disabled = Boolean(sessionId); }
});
historySearch.addEventListener("input", () => renderHistory(historyCache));
historyList.addEventListener("change", () => { resumeButton.disabled = !historyList.value || Boolean(sessionId); });
resumeButton.addEventListener("click", async () => {
  const selected = historyList.value; if (!selected) return; resumeButton.disabled = true; setStatus("Loading session history…");
  try {
    resetPresentation(); replayingHistory = true;
    const loaded = await api.load(consumeRequestFromForm(), selected); activeTurn = null; sessionId = loaded.sessionId; setStatus(`Loaded · ${sessionId.slice(0, 16)}…`); setSessionControls(true);
  } catch (error: any) { activeTurn = null; setStatus(error?.message ?? String(error)); resumeButton.disabled = false; }
  finally { replayingHistory = false; finishCurrentStreams(); renderConversationWindow(); renderTrajectoryWindow(); }
});
startButton.addEventListener("click", async () => {
  startButton.disabled = true; setStatus("Starting ACP…");
  try { const started = await api.start(consumeRequestFromForm()); sessionId = started.sessionId; resetPresentation(); setStatus(`Connected · ${sessionId.slice(0, 16)}…`); setSessionControls(true); }
  catch (error: any) { setStatus(error?.message ?? String(error)); }
  finally { startButton.disabled = false; }
});
closeSessionButton.addEventListener("click", async () => {
  if (!sessionId) return; closeSessionButton.disabled = true;
  try { await api.closeSession(sessionId); finishActiveTurn("cancelled"); finishCurrentStreams(); toolCards.clear(); toolPresentations.clear(); toolTrajectory.clear(); interactionTrajectory.clear(); setStatus("Session closed · history remains durable"); }
  catch (error: any) { setStatus(error?.message ?? String(error)); }
});
sendButton.addEventListener("click", async () => {
  const text = composer.value.trim(); if (!text || !sessionId) return;
  finishCurrentStreams(); const userBody = addMessage("user", text); beginTurn(text, userBody.parentElement ?? userBody); composer.value = "";
  assistantTrajectory = null; reasoningTrajectory = null; sendButton.disabled = true; stopButton.disabled = false;
  try {
    const result = await api.prompt(sessionId, text); finishActiveTurn(result.stopReason === "cancelled" ? "cancelled" : "completed");
  } catch (error: any) { finishActiveTurn("failed"); addMessage("system", `Error: ${error?.message ?? error}`); }
  finally { finishCurrentStreams(); sendButton.disabled = false; stopButton.disabled = true; }
});
composer.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendButton.click(); } });
stopButton.addEventListener("click", () => { if (sessionId) void api.cancel(sessionId); });
detailsToggle.addEventListener("click", () => {
  const collapsed = workarea.classList.toggle("details-collapsed");
  detailsPane.setAttribute("aria-hidden", String(collapsed)); detailsToggle.setAttribute("aria-expanded", String(!collapsed)); detailsToggle.textContent = collapsed ? "Show details" : "Details";
  if (collapsed && document.activeElement instanceof HTMLElement && detailsPane.contains(document.activeElement)) detailsToggle.focus();
});
trajectoryTab.addEventListener("click", () => activateDetailsTab("trajectory"));
artifactTab.addEventListener("click", () => activateDetailsTab("artifact"));
for (const [tabButton, target] of [[trajectoryTab, "trajectory"], [artifactTab, "artifact"]] as const) tabButton.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); activateDetailsTab(target === "trajectory" ? "artifact" : "trajectory", true); }
});
trajectorySearch.addEventListener("input", () => applyTrajectoryFilters(true));
trajectoryFilter.addEventListener("change", () => applyTrajectoryFilters(true));
conversationPrev.addEventListener("click", () => { conversationWindowStart = Math.max(0, conversationWindowStart - DESKTOP_UI_BUDGETS.conversationWindow); renderConversationWindow(); });
conversationNext.addEventListener("click", () => { conversationWindowStart += DESKTOP_UI_BUDGETS.conversationWindow; renderConversationWindow(); });
conversationLatest.addEventListener("click", () => { conversationWindowStart = Math.max(0, conversationNodes.length - DESKTOP_UI_BUDGETS.conversationWindow); renderConversationWindow(); messages.scrollTop = messages.scrollHeight; });
trajectoryPrev.addEventListener("click", () => { trajectoryWindowStart = Math.max(0, trajectoryWindowStart - DESKTOP_UI_BUDGETS.trajectoryWindow); renderTrajectoryWindow(); });
trajectoryNext.addEventListener("click", () => { trajectoryWindowStart += DESKTOP_UI_BUDGETS.trajectoryWindow; renderTrajectoryWindow(); });
trajectoryLatest.addEventListener("click", () => { trajectoryWindowStart = Math.max(0, matchingTrajectoryViews().length - DESKTOP_UI_BUDGETS.trajectoryWindow); renderTrajectoryWindow(); trajectoryList.scrollTop = trajectoryList.scrollHeight; });
mode.addEventListener("change", () => { if (sessionId) void api.setMode(sessionId, mode.value as "coder" | "craft" | "plan" | "ask"); });
previewArtifactButton.addEventListener("click", async () => {
  activateDetailsTab("artifact");
  try { const preview = await api.previewArtifact(artifactPath.value); artifactMeta.textContent = `${preview.name} · ${preview.size} bytes${preview.truncated ? " · preview truncated" : ""}${preview.binary ? " · binary" : ""}`; artifactPreview.textContent = preview.text; }
  catch (error: any) { artifactMeta.textContent = error?.message ?? String(error); artifactPreview.textContent = ""; }
});
openArtifactButton.addEventListener("click", async () => { try { await api.openArtifact(artifactPath.value); } catch (error: any) { setStatus(error?.message ?? String(error)); } });
recoverSessionButton.addEventListener("click", async () => {
  recoverSessionButton.disabled = true;
  try { const recovered = await api.recoverInterruptedTurn("recover", consumeRequestFromForm()); recoveryBanner.classList.add("hidden"); if (recovered.sessionId) { sessionId = recovered.sessionId; setSessionControls(true); setStatus(`Recovered session context · ${sessionId.slice(0, 16)}…`); } }
  catch (error: any) { setStatus(`Recovery: ${error?.message ?? String(error)}`); }
  finally { recoverSessionButton.disabled = false; }
});
dismissRecoveryButton.addEventListener("click", async () => { await api.recoverInterruptedTurn("dismiss"); recoveryBanner.classList.add("hidden"); });

function appendTrajectoryText(view: TrajectoryView, chunk: string): void {
  const previous = (view.detail && typeof view.detail === "object" ? view.detail as { text?: unknown; omittedChars?: unknown } : {});
  const priorText = typeof previous.text === "string" ? previous.text : ""; const priorOmitted = typeof previous.omittedChars === "number" ? previous.omittedChars : 0;
  const room = Math.max(0, DESKTOP_UI_BUDGETS.trajectoryDetailPreviewChars - priorText.length); const appended = chunk.slice(0, room); const omitted = priorOmitted + Math.max(0, chunk.length - appended.length);
  const text = priorText + appended; view.detail = omitted ? { text, omittedChars: omitted } : { text }; view.subtitle = text.slice(0, 120); refreshTrajectoryView(view);
}
function handleUpdate(payload: unknown): void {
  const projected = projectDesktopSessionUpdate(payload); if (!projected) return;
  if (projected.kind === "user") {
    finishCurrentStreams(); const body = addMessage("user", projected.text); beginTurn(projected.text, body.parentElement ?? body, replayingHistory ? "history" : "in_progress");
    assistantTrajectory = null; reasoningTrajectory = null; return;
  }
  if (projected.kind === "assistant") {
    const presentation = presentDesktopMessage(projected);
    if (reasoningTrajectory) { reasoningTrajectory.status = "completed"; refreshTrajectoryView(reasoningTrajectory); reasoningTrajectory = null; reasoningStream?.finish(); reasoningStream = null; reasoningBubble = null; }
    if (!assistantBubble) { assistantBubble = addMessage("assistant", ""); assistantBubble.parentElement?.setAttribute("data-presentation", presentation.kind); assistantStream = new IncrementalMarkdownRenderer(assistantBubble); }
    assistantStream?.append(presentation.text);
    if (!assistantTrajectory) assistantTrajectory = addTrajectory("message", presentation.label, presentation.text.slice(0, 120), { text: "" }, "", { turn: activeTurnNumber || undefined, conversationTarget: assistantBubble.parentElement ?? assistantBubble });
    appendTrajectoryText(assistantTrajectory, presentation.text); scheduleConversationWindow(true); return;
  }
  if (projected.kind === "reasoning") {
    const presentation = presentDesktopMessage(projected);
    if (assistantStream) { assistantStream.finish(); assistantStream = null; assistantBubble = null; assistantTrajectory = null; }
    if (!reasoningBubble) { reasoningBubble = addMessage("reasoning", ""); reasoningBubble.parentElement?.setAttribute("data-presentation", presentation.kind); reasoningStream = new IncrementalTextRenderer(reasoningBubble); }
    reasoningStream?.append(presentation.text);
    if (!reasoningTrajectory) reasoningTrajectory = addTrajectory("reasoning", presentation.label, presentation.text.slice(0, 120), { text: "" }, "in_progress", { badge: "think", turn: activeTurnNumber || undefined, conversationTarget: reasoningBubble.parentElement ?? reasoningBubble });
    appendTrajectoryText(reasoningTrajectory, presentation.text); scheduleConversationWindow(true); return;
  }
  if (projected.kind === "tool") {
    assistantStream?.finish(); assistantStream = null; assistantBubble = null; assistantTrajectory = null;
    reasoningStream?.finish(); reasoningStream = null; reasoningBubble = null;
    if (reasoningTrajectory) { reasoningTrajectory.status = "completed"; refreshTrajectoryView(reasoningTrajectory); reasoningTrajectory = null; }
    const previous = toolPresentations.get(projected.toolCallId); const presentation = presentDesktopToolEvent(projected, previous); toolPresentations.set(projected.toolCallId, presentation); registerToolArtifactEvidence(presentation);
    let card = toolCards.get(projected.toolCallId);
    if (!card) { card = createToolCard(presentation); toolCards.set(projected.toolCallId, card); appendConversationNode(card.root); } else renderToolCard(card, presentation);
    let trajectory = toolTrajectory.get(projected.toolCallId);
    if (!trajectory) {
      trajectory = addTrajectory("tool", presentation.title, presentation.summary, presentation, presentation.status, { badge: presentation.cardKind, turn: activeTurnNumber || undefined, conversationTarget: card.root, toolPresentation: presentation }); toolTrajectory.set(projected.toolCallId, trajectory);
    } else {
      trajectory.status = presentation.status; trajectory.subtitle = presentation.summary; trajectory.detail = presentation; trajectory.toolPresentation = presentation; trajectory.conversationTarget = card.root; refreshTrajectoryView(trajectory);
    }
    for (const interaction of interactionTrajectory.values()) if (interaction.presentation.toolCallId === projected.toolCallId && !interaction.view.conversationTarget) interaction.view.conversationTarget = card.root;
    return;
  }
  if (projected.kind === "mode") { if (projected.modeId) mode.value = projected.modeId; addTrajectory("mode", "Mode changed", projected.modeId || "unknown", projected); return; }
  addTrajectory("event", `ACP · ${projected.sessionUpdate}`, "Unrecognized presentation event", projected, "", { turn: activeTurnNumber || undefined });
}


function showHostRequestDialog(event: Extract<DesktopEvent, { type: "host-request" }>): Promise<unknown> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  hostDialog.classList.remove("hidden"); hostDialogField.replaceChildren(); hostDialogActions.replaceChildren(); hostDialogDetail.classList.add("hidden"); hostDialogDetail.textContent = "";
  return new Promise((resolve) => {
    let settled = false; const finish = (value: unknown) => { if (settled) return; settled = true; hostDialog.classList.add("hidden"); hostDialogCancel.onclick = null; hostDialog.onkeydown = null; previousFocus?.focus(); resolve(value); };
    hostDialogCancel.onclick = () => finish(null); hostDialog.onkeydown = (keyEvent) => {
      if (keyEvent.key === "Escape") { keyEvent.preventDefault(); finish(null); return; }
      if (keyEvent.key !== "Tab") return;
      const focusable = Array.from(hostDialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((node) => !node.classList.contains("hidden"));
      if (!focusable.length) { keyEvent.preventDefault(); hostDialogCancel.focus(); return; }
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!; const active = document.activeElement;
      if (keyEvent.shiftKey && active === first) { keyEvent.preventDefault(); last.focus(); }
      else if (!keyEvent.shiftKey && active === last) { keyEvent.preventDefault(); first.focus(); }
    };
    if (event.requestKind === "permission") {
      const payload = event.payload as any; hostDialogTitle.textContent = payload?.toolCall?.title ?? "Approve tool?"; hostDialogMessage.textContent = "FreeSeek is requesting permission through the ACP security boundary.";
      if (payload?.toolCall?.rawInput !== undefined) { hostDialogDetail.textContent = boundedUnknownText(payload.toolCall.rawInput, 4_000).text; hostDialogDetail.classList.remove("hidden"); }
      for (const option of Array.isArray(payload?.options) ? payload.options : []) { const button = document.createElement("button"); button.type = "button"; button.textContent = String(option?.name ?? option?.optionId ?? "Select"); button.dataset.kind = String(option?.kind ?? ""); button.addEventListener("click", () => finish(String(option?.optionId ?? ""))); hostDialogActions.append(button); }
      window.requestAnimationFrame(() => (hostDialogActions.querySelector("button") as HTMLButtonElement | null)?.focus()); return;
    }
    const payload = event.payload as any; hostDialogTitle.textContent = "FreeSeek needs input"; hostDialogMessage.textContent = String(payload?.message ?? "Provide a value to continue.");
    const schema = payload?.requestedSchema?.properties?.value ?? { type: "string" }; const enumValues = Array.isArray(schema?.enum) ? schema.enum.map(String) : Array.isArray(schema?.items?.enum) ? schema.items.enum.map(String) : [];
    let readValue: () => unknown; let primaryField: HTMLElement | null = null;
    if (schema?.type === "array" && enumValues.length) { const boxes: HTMLInputElement[] = []; for (const value of enumValues) { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.value = value; boxes.push(input); if (!primaryField) primaryField = input; label.append(input, document.createTextNode(value)); hostDialogField.append(label); } readValue = () => boxes.filter((box) => box.checked).map((box) => box.value); }
    else if (enumValues.length) { const select = document.createElement("select"); for (const value of enumValues) { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); } hostDialogField.append(select); primaryField = select; readValue = () => select.value; }
    else { const input = document.createElement("input"); input.type = "text"; hostDialogField.append(input); primaryField = input; readValue = () => input.value; }
    const submit = document.createElement("button"); submit.type = "button"; submit.className = "primary"; submit.textContent = "Continue"; submit.addEventListener("click", () => finish(readValue())); hostDialogActions.append(submit); window.requestAnimationFrame(() => primaryField?.focus());
  });
}


function handleHostRequest(event: Extract<DesktopEvent, { type: "host-request" }>): void {
  const presentation = projectDesktopHostRequest(event);
  const linkedCard = presentation.toolCallId ? toolCards.get(presentation.toolCallId)?.root : undefined;
  const view = addTrajectory(presentation.kind, presentation.title, presentation.summary, presentation.detail, presentation.status, {
    badge: presentation.kind === "permission" ? "perm" : "ask",
    turn: activeTurnNumber || undefined,
    ...(linkedCard ? { conversationTarget: linkedCard } : {}),
  });
  interactionTrajectory.set(event.requestId, { presentation, view });
  void showHostRequestDialog(event).then((value) => {
    const completed = completeDesktopHostRequest(presentation, value);
    interactionTrajectory.set(event.requestId, { presentation: completed, view });
    view.subtitle = completed.summary; view.status = completed.status; view.detail = completed.detail; refreshTrajectoryView(view);
    api.respondHostRequest(event.requestId, value);
  });
}

api.onEvent((event: DesktopEvent) => {
  if (event.type === "status") setStatus(event.text);
  else if (event.type === "session") { sessionId = event.sessionId; setSessionControls(Boolean(sessionId)); }
  else if (event.type === "session-update") handleUpdate(event.payload);
  else if (event.type === "error") addMessage("system", event.text);
  else if (event.type === "recovery") { recoveryText.textContent = `${event.state.sessionId.slice(0, 18)}… · ${event.state.workspace}`; recoveryBanner.classList.remove("hidden"); if (!workspace.value) workspace.value = event.state.workspace; }
  else if (event.type === "host-request") handleHostRequest(event);
});

setSessionControls(false);
activateDetailsTab("trajectory"); updateTrajectoryCount();
void api.getSettings().then(applySettings).catch((error) => setStatus(`Settings: ${error?.message ?? String(error)}`));
