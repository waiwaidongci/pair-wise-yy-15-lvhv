// 存档层：离线 localStorage 读写、种子数据、登记/更正的不可变版本管理。
// 更正饲料、体重或放飞参数都不会覆盖旧版本——旧版只读，排行永远取最新版。

import {
  Archive,
  Flight,
  FlightVersion,
  FeedBatch,
  Pigeon,
  ViewState,
  RATION_PER_FLIGHT_KG,
} from "./rules";

const STORE_KEY = "pigeon-loft-archive-v1";
const VIEW_KEY = "pigeon-loft-view-v1";

// ---------- 种子数据 ----------

function seed(): Archive {
  const batches: FeedBatch[] = [
    { id: "b1", code: "FD-2026-0901", name: "赛飞粮·秋季批", status: "active", stockKg: 12.5 },
    { id: "b2", code: "FD-2026-0815", name: "赛飞粮·陈批", status: "active", stockKg: 0.02 },
    { id: "b3", code: "FD-2026-0730", name: "换羽粮·停用批", status: "inactive", stockKg: 8 },
  ];

  const pigeons: Pigeon[] = [
    { id: "p1", ringNo: "CHN-24-001839", bloodline: "詹森系", weightG: 460, weightMinG: 420, weightMaxG: 500, health: "normal", batchId: "b1", pairing: "CHN-23-008771" },
    { id: "p2", ringNo: "CHN-24-002114", bloodline: "凡龙系", weightG: 480, weightMinG: 430, weightMaxG: 510, health: "normal", batchId: "b1" },
    { id: "p3", ringNo: "CHN-23-008771", bloodline: "胡本系", weightG: 455, weightMinG: 420, weightMaxG: 490, health: "normal", batchId: "b2" },
    { id: "p4", ringNo: "CHN-24-003207", bloodline: "凡龙系", weightG: 401, weightMinG: 430, weightMaxG: 500, health: "normal", batchId: "b1" },
    { id: "p5", ringNo: "CHN-25-004552", bloodline: "詹森系", weightG: 470, weightMinG: 430, weightMaxG: 500, health: "abnormal", batchId: "b3" },
  ];

  const mk = (
    id: string,
    pigeonId: string,
    date: string,
    versions: FlightVersion[],
    batch: FeedBatch,
    p: Pigeon
  ): Flight => ({
    id,
    pigeonId,
    date,
    versions,
    snapshot: { batchCode: batch.code, batchStatus: batch.status, stockKg: batch.stockKg, weightG: p.weightG, health: p.health },
  });

  const p1 = pigeons[0], p2 = pigeons[1], p3 = pigeons[2], p4 = pigeons[3], p5 = pigeons[4];
  const b1 = batches[0], b2 = batches[1], b3 = batches[2];

  const flights: Flight[] = [
    // 中距离一次登记后更正距离（120→118km）：旧版只读，排行按 v2 重算。
    mk(
      "f1",
      "p1",
      "2026-09-18",
      [
        { version: 1, at: "2026-09-18T11:30:00.000Z", location: "新乡", distanceKm: 120, weather: "晴", releasedAt: "2026-09-18T07:00", homedAt: "2026-09-18T08:42", durationMin: 102, outcome: "homed" },
        { version: 2, at: "2026-09-19T02:10:00.000Z", location: "新乡", distanceKm: 118, weather: "晴", releasedAt: "2026-09-18T07:00", homedAt: "2026-09-18T08:42", durationMin: 102, outcome: "homed", reason: "GPS 复核，实际空距 118km" },
      ],
      b1, p1
    ),
    // 短训，正常。
    mk(
      "f2", "p2", "2026-09-19",
      [{ version: 1, at: "2026-09-19T02:40:00.000Z", location: "原阳", distanceKm: 60, weather: "多云", releasedAt: "2026-09-19T07:10", homedAt: "2026-09-19T08:05", durationMin: 55, outcome: "homed" }],
      b1, p2
    ),
    // 中训，但所在批次日粮不足：不得进入中长距离排行。
    mk(
      "f3", "p3", "2026-09-19",
      [{ version: 1, at: "2026-09-19T03:00:00.000Z", location: "许昌", distanceKm: 160, weather: "侧风", releasedAt: "2026-09-19T06:50", homedAt: "2026-09-19T09:02", durationMin: 132, outcome: "homed" }],
      b2, p3
    ),
    // 短训，但体重偏离区间：可短训，不入中长距离榜（本就短训，照常参与短榜判定）。
    mk(
      "f4", "p4", "2026-09-20",
      [{ version: 1, at: "2026-09-20T01:50:00.000Z", location: "黄河滩", distanceKm: 35, weather: "晴", releasedAt: "2026-09-20T07:20", homedAt: "2026-09-20T07:47", durationMin: 27, outcome: "homed" }],
      b1, p4
    ),
    // 长训正常归巢。
    mk(
      "f5", "p1", "2026-09-20",
      [{ version: 1, at: "2026-09-20T13:10:00.000Z", location: "武汉", distanceKm: 520, weather: "逆风", releasedAt: "2026-09-20T06:30", homedAt: "2026-09-20T14:05", durationMin: 455, outcome: "homed" }],
      b1, p1
    ),
    // 健康异常 + 停用批次：只允许短训。
    mk(
      "f6", "p5", "2026-09-20",
      [{ version: 1, at: "2026-09-20T02:20:00.000Z", location: "桥南", distanceKm: 20, weather: "阴", releasedAt: "2026-09-20T07:30", homedAt: "2026-09-20T07:49", durationMin: 19, outcome: "homed" }],
      b3, p5
    ),
    // 未归巢：进入提醒，不参与排行。
    mk(
      "f7", "p2", "2026-09-21",
      [{ version: 1, at: "2026-09-21T01:00:00.000Z", location: "长沙", distanceKm: 720, weather: "大雾", releasedAt: "2026-09-21T06:20", homedAt: "", durationMin: 0, outcome: "missing" }],
      b1, p2
    ),
  ];

  return { batches, pigeons, flights };
}

// ---------- 读写 ----------

function isArchive(x: unknown): x is Archive {
  return (
    !!x &&
    typeof x === "object" &&
    Array.isArray((x as Archive).batches) &&
    Array.isArray((x as Archive).pigeons) &&
    Array.isArray((x as Archive).flights)
  );
}

export function loadArchive(): Archive {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isArchive(parsed)) return parsed;
    }
  } catch {
    // 存档损坏时回退种子，保证离线可用。
  }
  return seed();
}

export function saveArchive(archive: Archive): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(archive));
  } catch {
    // 隐私模式等场景静默失败，内存状态仍可用。
  }
}

export function resetArchive(): Archive {
  const fresh = seed();
  saveArchive(fresh);
  return fresh;
}

export function exportArchive(archive: Archive): void {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pigeon-loft-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importArchive(file: File): Promise<Archive> {
  return file.text().then((text) => {
    const parsed = JSON.parse(text);
    if (!isArchive(parsed)) throw new Error("文件不是有效的赛鸽棚存档");
    saveArchive(parsed);
    return parsed;
  });
}

// ---------- 视图状态（刷新后筛选保持一致） ----------

const DEFAULT_VIEW: ViewState = { tab: "overview", tier: "all", bloodline: "", selectedPigeonId: "" };

export function loadView(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) return { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<ViewState>) };
  } catch {
    // ignore
  }
  return DEFAULT_VIEW;
}

export function saveView(view: ViewState): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // ignore
  }
}

// ---------- 不可变变更 ----------

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export interface FlightDraft {
  pigeonId: string;
  date: string;
  location: string;
  distanceKm: number;
  weather: string;
  releasedAt: string;
  homedAt: string;
  durationMin: number;
  outcome: "homed" | "missing";
  reason?: string;
}

function snapshotFor(archive: Archive, p: Pigeon): Flight["snapshot"] {
  const batch = archive.batches.find((b) => b.id === p.batchId);
  return {
    batchCode: batch?.code ?? "未关联",
    batchStatus: batch?.status ?? "inactive",
    stockKg: batch?.stockKg ?? 0,
    weightG: p.weightG,
    health: p.health,
  };
}

// 登记新训放：追加一条全新记录。
export function addFlight(archive: Archive, draft: FlightDraft): Archive {
  const p = archive.pigeons.find((x) => x.id === draft.pigeonId);
  if (!p) return archive;
  const flight: Flight = {
    id: nextId("f"),
    pigeonId: draft.pigeonId,
    date: draft.date,
    versions: [
      {
        version: 1,
        at: new Date().toISOString(),
        location: draft.location.trim(),
        distanceKm: draft.distanceKm,
        weather: draft.weather,
        releasedAt: draft.releasedAt,
        homedAt: draft.outcome === "homed" ? draft.homedAt : "",
        durationMin: draft.outcome === "homed" ? draft.durationMin : 0,
        outcome: draft.outcome,
      },
    ],
    snapshot: snapshotFor(archive, p),
  };
  return { ...archive, flights: [...archive.flights, flight] };
}

// 更正放飞参数：旧版本保留只读，追加新版本，排行/提醒立即取最新版。
export function reviseFlight(archive: Archive, flightId: string, draft: FlightDraft): Archive {
  return {
    ...archive,
    flights: archive.flights.map((f) => {
      if (f.id !== flightId) return f;
      const last = f.versions[f.versions.length - 1];
      const p = archive.pigeons.find((x) => x.id === f.pigeonId)!;
      const next: FlightVersion = {
        version: last.version + 1,
        at: new Date().toISOString(),
        location: draft.location.trim() || last.location,
        distanceKm: draft.distanceKm || last.distanceKm,
        weather: draft.weather || last.weather,
        releasedAt: draft.releasedAt || last.releasedAt,
        homedAt: draft.outcome === "homed" ? draft.homedAt : "",
        durationMin: draft.outcome === "homed" ? draft.durationMin : 0,
        outcome: draft.outcome,
        reason: draft.reason?.trim() || "参数更正",
      };
      return {
        ...f,
        date: draft.date || f.date,
        versions: [...f.versions, next],
        snapshot: snapshotFor(archive, p),
      };
    }),
  };
}

export function upsertPigeon(archive: Archive, p: Pigeon): Archive {
  const exists = archive.pigeons.some((x) => x.id === p.id);
  return {
    ...archive,
    pigeons: exists ? archive.pigeons.map((x) => (x.id === p.id ? p : x)) : [...archive.pigeons, p],
  };
}

export function upsertBatch(archive: Archive, b: FeedBatch): Archive {
  const exists = archive.batches.some((x) => x.id === b.id);
  return {
    ...archive,
    batches: exists ? archive.batches.map((x) => (x.id === b.id ? b : x)) : [...archive.batches, b],
  };
}

export { RATION_PER_FLIGHT_KG };
