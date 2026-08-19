import { el } from "./components-base";

// ── 输入框补全弹层状态（@提及文件 / /命令，对标 Claude Code 的 @ 与 /）──
let acEl: HTMLElement | null = null;
let acItems: Array<{ label: string; value: string; hint?: string }> = [];
let acIndex = 0;
let acOnPick: ((item: { label: string; value: string; hint?: string }) => void) | null = null;

export function showAutocomplete(
  items: Array<{ label: string; value: string; hint?: string }>,
  onPick: (item: { label: string; value: string; hint?: string }) => void
): void {
  acItems = items;
  acIndex = 0;
  acOnPick = onPick;
  if (!acEl) {
    acEl = el("div", "autocomplete");
    document.body.appendChild(acEl);
  }
  renderAutocomplete();
  positionAutocomplete();
  acEl.style.display = "block";
}

function renderAutocomplete(): void {
  if (!acEl) return;
  acEl.innerHTML = "";
  if (!acItems.length) {
    acEl.appendChild(el("div", "ac-empty", "无匹配"));
    return;
  }
  acItems.forEach((it, i) => {
    const row = el("div", "ac-item" + (i === acIndex ? " active" : ""));
    row.appendChild(el("span", "ac-label", it.label));
    if (it.hint) row.appendChild(el("span", "ac-hint", it.hint));
    row.addEventListener("click", () => {
      acIndex = i;
      pickAutocomplete();
    });
    acEl!.appendChild(row);
  });
}

function positionAutocomplete(): void {
  if (!acEl) return;
  const input = document.getElementById("input");
  if (!input) return;
  const rect = input.getBoundingClientRect();
  acEl.style.left = rect.left + "px";
  acEl.style.width = Math.max(rect.width, 240) + "px";
  acEl.style.bottom = window.innerHeight - rect.top + 6 + "px";
}

export function moveAutocomplete(delta: number): void {
  if (!acItems.length) return;
  acIndex = (acIndex + delta + acItems.length) % acItems.length;
  renderAutocomplete();
  const active = acEl?.querySelector(".ac-item.active") as HTMLElement | null;
  active?.scrollIntoView({ block: "nearest" });
}

export function pickAutocomplete(): void {
  const it = acItems[acIndex];
  if (it && acOnPick) acOnPick(it);
  hideAutocomplete();
}

export function hideAutocomplete(): void {
  if (acEl) acEl.style.display = "none";
  acItems = [];
  acOnPick = null;
}

export function isAutocompleteOpen(): boolean {
  return !!acEl && acEl.style.display !== "none" && acItems.length > 0;
}

// ── 导出：收集当前对话为扁平消息数组（排除工具 / diff / 子智能体 / 任务清单卡片）──
export function collectMessages(): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  const nodes = document.querySelectorAll<HTMLElement>("#messages > .msg");
  for (const node of Array.from(nodes)) {
    const cls = node.className || "";
    if (cls.includes("user")) {
      const b = node.querySelector(".bubble");
      const text = b?.textContent || "";
      if (text.trim()) out.push({ role: "user", content: text });
    } else if (
      cls.includes("assistant") &&
      !cls.includes("tool") &&
      !cls.includes("diffcard") &&
      !cls.includes("subagent") &&
      !cls.includes("todos")
    ) {
      const b = node.querySelector(".bubble");
      const raw = b?.getAttribute("data-raw") || b?.textContent || "";
      if (raw.trim()) out.push({ role: "assistant", content: raw });
    }
  }
  return out;
}

export function openExportMenu(): void {
  document.getElementById("exportMenu")?.classList.add("open");
}

export function closeExportMenu(): void {
  document.getElementById("exportMenu")?.classList.remove("open");
}
