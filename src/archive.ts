// 存档层：localStorage 持久化、种子数据、旧版只读快照（修订归档）。
// 只负责数据存取，不放业务判定逻辑（判定见 rules.ts），不放界面（见 App.tsx）。

import type {
  AppState,
  FeedBatch,
  Filters,
  Pigeon,
  Revision,
  RevisionKind,
  TrainingRecord,
} from "./rules";

const STATE_KEY = "pigeon-desk.state.v1";
const FILTERS_KEY = "pigeon-desk.filters.v1";

export const DEFAULT_FILTERS: Filters = {
  bloodline: "全部",
  category: "all",
  missingOnly: false,
};

// ---------- 初始种子（离线开箱即可看到规则效果） ----------

function seedState(): AppState {
  const pigeons: Pigeon[] = [
    {
      id: "p1",
      ring: "CHN-24-001839",
      bloodline: "詹森系",
      weightG: 480,
      minWeightG: 440,
      maxWeightG: 520,
      health: "normal",
      batchId: "b1",
    },
    {
      id: "p2",
      ring: "CHN-24-002114",
      bloodline: "凡龙系",
      weightG: 462,
      minWeightG: 430,
      maxWeightG: 500,
      health: "normal",
      batchId: "b1",
    },
    {
      id: "p3",
      ring: "CHN-23-008771",
      bloodline: "胡本系",
      weightG: 552,
      minWeightG: 440,
      maxWeightG: 520,
      health: "normal",
      batchId: "b2", // 日粮不足批次
    },
    {
      id: "p4",
      ring: "CHN-25-000642",
      bloodline: "詹森系",
      weightG: 405,
      minWeightG: 430,
      maxWeightG: 510,
      health: "normal",
      batchId: "b1", // 体重偏低
    },
    {
      id: "p5",
      ring: "CHN-23-009905",
      bloodline: "凡龙系",
      weightG: 470,
      minWeightG: 430,
      maxWeightG: 500,
      health: "abnormal",
      batchId: "b1", // 健康异常
    },
    {
      id: "p6",
      ring: "CHN-25-000118",
      bloodline: "考夫曼系",
      weightG: 488,
      minWeightG: 440,
      maxWeightG: 520,
      health: "normal",
      batchId: "b3", // 批次停用
    },
  ];

  const batches: FeedBatch[] = [
    { id: "b1", name: "2026-春-A1 标准日粮", active: true, rationG: 32, stockG: 4000 },
    { id: "b2", name: "2026-春-B2 油料配比", active: true, rationG: 35, stockG: 20 },
    { id: "b3", name: "2025-冬-C3 旧批次", active: false, rationG: 30, stockG: 1500 },
  ];

  const records: TrainingRecord[] = [
    {
      id: "r1",
      pigeonId: "p1",
      date: "2026-09-18",
      location: "顺义放飞点",
      distanceKm: 60,
      weather: "晴",
      releaseAt: "2026-09-18T07:10",
      homeAt: "2026-09-18T08:12",
      rev: 1,
    },
    {
      id: "r2",
      pigeonId: "p2",
      date: "2026-09-19",
      location: "保定东站",
      distanceKm: 150,
      weather: "侧风",
      releaseAt: "2026-09-19T06:50",
      homeAt: "2026-09-19T09:25",
      rev: 1,
    },
    {
      id: "r3",
      pigeonId: "p1",
      date: "2026-09-20",
      location: "石家庄服务区",
      distanceKm: 260,
      weather: "晴",
      releaseAt: "2026-09-20T06:30",
      homeAt: "2026-09-20T10:42",
      rev: 1,
    },
    {
      id: "r4",
      pigeonId: "p6",
      date: "2026-09-20",
      location: "高邑训放点",
      distanceKm: 180,
      weather: "多云",
      releaseAt: "2026-09-20T07:00",
      homeAt: "2026-09-20T09:50",
      rev: 1,
    },
    {
      id: "r5",
      pigeonId: "p3",
      date: "2026-09-20",
      location: "邢台训放点",
      distanceKm: 220,
      weather: "逆风",
      releaseAt: "2026-09-20T06:40",
      homeAt: "2026-09-20T11:10",
      rev: 1,
    },
    {
      id: "r6",
      pigeonId: "p4",
      date: "2026-09-20",
      location: "通州放飞点",
      distanceKm: 50,
      weather: "晴",
      releaseAt: "2026-09-20T07:20",
      homeAt: "2026-09-20T08:05",
      rev: 1,
    },
    {
      id: "r7",
      pigeonId: "p5",
      date: "2026-09-19",
      location: "保定东站",
      distanceKm: 150,
      weather: "侧风",
      releaseAt: "2026-09-19T06:50",
      homeAt: "2026-09-19T09:40",
      rev: 1,
    },
    {
      id: "r8",
      pigeonId: "p2",
      date: "2026-09-21",
      location: "沧州西站",
      distanceKm: 220,
      weather: "小雨",
      releaseAt: "2026-09-21T06:35",
      homeAt: "",
      rev: 1,
    },
  ];

  const revisions: Revision[] = [
    {
      id: "rev-seed-1",
      at: "2026-09-17T20:10:00",
      kind: "pigeon",
      entityId: "p3",
      title: "CHN-23-008771 体重期初更正",
      note: "期初称重 576g 更正为 552g（旧版只读）",
      snapshot: {
        ring: "CHN-23-008771",
        field: "weightG",
        oldValue: 576,
        newValue: 552,
      },
    },
  ];

  return { pigeons, batches, records, revisions };
}

// ---------- 持久化 ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalizePigeon(v: unknown): Pigeon | null {
  const o = asRecord(v);
  if (!o || !str(o.id) || !str(o.ring)) return null;
  return {
    id: str(o.id),
    ring: str(o.ring),
    bloodline: str(o.bloodline, "未登记"),
    weightG: num(o.weightG),
    minWeightG: num(o.minWeightG),
    maxWeightG: num(o.maxWeightG),
    health: o.health === "abnormal" ? "abnormal" : "normal",
    batchId: str(o.batchId),
  };
}

function normalizeBatch(v: unknown): FeedBatch | null {
  const o = asRecord(v);
  if (!o || !str(o.id)) return null;
  return {
    id: str(o.id),
    name: str(o.name, "未命名批次"),
    active: bool(o.active, true),
    rationG: num(o.rationG),
    stockG: num(o.stockG),
  };
}

function normalizeRecord(v: unknown): TrainingRecord | null {
  const o = asRecord(v);
  if (!o || !str(o.id) || !str(o.pigeonId)) return null;
  return {
    id: str(o.id),
    pigeonId: str(o.pigeonId),
    date: str(o.date),
    location: str(o.location),
    distanceKm: num(o.distanceKm),
    weather: str(o.weather, "晴"),
    releaseAt: str(o.releaseAt),
    homeAt: str(o.homeAt),
    rev: num(o.rev, 1),
  };
}

function normalizeRevision(v: unknown): Revision | null {
  const o = asRecord(v);
  if (!o || !str(o.id)) return null;
  const kind: RevisionKind =
    o.kind === "pigeon" || o.kind === "batch" ? o.kind : "record";
  return {
    id: str(o.id),
    at: str(o.at),
    kind,
    entityId: str(o.entityId),
    title: str(o.title),
    note: str(o.note),
    snapshot:
      asRecord(o.snapshot) ?? ({} as Record<string, unknown>),
  };
}

/** 读取存档；结构损坏时回退到种子数据，避免页面白屏。 */
export function loadState(): AppState {
  const seed = seedState();
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return seed;
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return seed;
    return {
      pigeons: asArray(parsed.pigeons)
        .map(normalizePigeon)
        .filter((p): p is Pigeon => p !== null),
      batches: asArray(parsed.batches)
        .map(normalizeBatch)
        .filter((b): b is FeedBatch => b !== null),
      records: asArray(parsed.records)
        .map(normalizeRecord)
        .filter((r): r is TrainingRecord => r !== null),
      revisions: asArray(parsed.revisions)
        .map(normalizeRevision)
        .filter((r): r is Revision => r !== null),
    };
  } catch {
    return seed;
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 离线存储已满或被浏览器禁用时静默降级：排行仍在内存中即时重算。
  }
}

export function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const o = asRecord(JSON.parse(raw));
    if (!o) return DEFAULT_FILTERS;
    const category =
      o.category === "short" ||
      o.category === "middle" ||
      o.category === "long"
        ? o.category
        : "all";
    return {
      bloodline: str(o.bloodline, "全部"),
      category,
      missingOnly: bool(o.missingOnly),
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(filters: Filters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* 忽略持久化失败 */
  }
}

// ---------- 修订归档（旧版只读快照） ----------

let seq = 0;

export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function archiveRevision(
  kind: RevisionKind,
  entityId: string,
  title: string,
  note: string,
  snapshot: Record<string, unknown>,
): Revision {
  return {
    id: nextId("rev"),
    at: new Date().toISOString(),
    kind,
    entityId,
    title,
    note,
    snapshot,
  };
}
