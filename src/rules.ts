// 业务规则层：纯函数，不碰 DOM / localStorage，不渲染界面。
// 距离分级、饲料与体重核验、排训限制、排行与未归巢重算都在这里。

export type DistanceCategory = "short" | "middle" | "long";
export type HealthStatus = "normal" | "abnormal";
export type RevisionKind = "record" | "pigeon" | "batch";

export interface Pigeon {
  id: string;
  ring: string; // 足环号
  bloodline: string; // 血统
  weightG: number; // 当前体重 g
  minWeightG: number; // 体重区间下限
  maxWeightG: number; // 体重区间上限
  health: HealthStatus; // 健康状态
  batchId: string; // 绑定的饲料批次
}

export interface FeedBatch {
  id: string;
  name: string;
  active: boolean; // 启用 / 停用
  rationG: number; // 日粮标准 g/羽
  stockG: number; // 当前库存 g
}

export interface TrainingRecord {
  id: string;
  pigeonId: string;
  date: string; // YYYY-MM-DD
  location: string; // 登记地点
  distanceKm: number; // 放飞距离
  weather: string; // 天气
  releaseAt: string; // 放飞时刻 YYYY-MM-DDTHH:mm
  homeAt: string; // 归巢时刻，空串表示未归巢
  rev: number; // 更正版本号
}

export interface Revision {
  id: string;
  at: string; // 归档时间
  kind: RevisionKind;
  entityId: string;
  title: string;
  note: string;
  snapshot: Record<string, unknown>; // 旧版只读快照
}

export interface AppState {
  pigeons: Pigeon[];
  batches: FeedBatch[];
  records: TrainingRecord[];
  revisions: Revision[];
}

export interface Filters {
  bloodline: string; // "全部" 或具体血统
  category: "all" | DistanceCategory;
  missingOnly: boolean;
}

// 距离分级阈值（km）：短训 < 80；中距离 80–<200；长距离 >= 200
export const SHORT_LIMIT_KM = 80;
export const MIDDLE_LIMIT_KM = 200;

export const CATEGORY_LABEL: Record<DistanceCategory, string> = {
  short: "短训",
  middle: "中距离",
  long: "长距离",
};

export const WEATHERS = ["晴", "多云", "阴", "小雨", "侧风", "逆风"] as const;

export function categoryOf(distanceKm: number): DistanceCategory {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return "short";
  if (distanceKm < SHORT_LIMIT_KM) return "short";
  if (distanceKm < MIDDLE_LIMIT_KM) return "middle";
  return "long";
}

// ---------- 饲料批次核验 ----------

export function countAssigned(batchId: string, pigeons: Pigeon[]): number {
  return pigeons.filter((p) => p.batchId === batchId).length;
}

export type BatchState = "ok" | "insufficient" | "disabled";

export function batchStatus(
  batch: FeedBatch | undefined,
  assigned: number,
): BatchState {
  if (!batch || !batch.active) return "disabled";
  const demandG = assigned * batch.rationG;
  if (batch.stockG < demandG) return "insufficient";
  return "ok";
}

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  ok: "正常供给",
  insufficient: "日粮不足",
  disabled: "批次停用",
};

/** 饲料侧限制原因；返回非空数组表示该羽只能短训。 */
export function feedReasons(
  pigeon: Pigeon,
  batches: FeedBatch[],
  pigeons: Pigeon[],
): string[] {
  const batch = batches.find((b) => b.id === pigeon.batchId);
  if (!batch) return ["未绑定饲料批次，仅允许短训"];
  if (!batch.active) return [`饲料批次「${batch.name}」已停用，仅允许短训`];
  const assigned = countAssigned(batch.id, pigeons);
  const demandG = assigned * batch.rationG;
  if (batch.stockG < demandG) {
    return [
      `饲料批次「${batch.name}」日粮不足（库存 ${batch.stockG}g ＜ 当日需求 ${demandG}g），仅允许短训`,
    ];
  }
  return [];
}

// ---------- 体重核验 ----------

export type WeightState = "ok" | "low" | "high";

export function weightStatus(pigeon: Pigeon): WeightState {
  if (pigeon.weightG < pigeon.minWeightG) return "low";
  if (pigeon.weightG > pigeon.maxWeightG) return "high";
  return "ok";
}

/** 体重偏离区间的限制原因。 */
export function weightReason(pigeon: Pigeon): string | null {
  const ws = weightStatus(pigeon);
  if (ws === "low") {
    return `体重偏低（${pigeon.weightG}g ＜ 下限 ${pigeon.minWeightG}g），仅允许短训`;
  }
  if (ws === "high") {
    return `体重偏高（${pigeon.weightG}g ＞ 上限 ${pigeon.maxWeightG}g），仅允许短训`;
  }
  return null;
}

/**
 * 短训限制：饲料批次停用 / 日粮不足 / 体重偏离区间，命中任一即只能短训。
 */
export function shortOnlyReasons(
  pigeon: Pigeon,
  batches: FeedBatch[],
  pigeons: Pigeon[],
): string[] {
  const reasons = feedReasons(pigeon, batches, pigeons);
  const wr = weightReason(pigeon);
  if (wr) reasons.push(wr);
  return reasons;
}

// ---------- 归巢、用时、分速 ----------

export interface DerivedRecord {
  category: DistanceCategory;
  returned: boolean;
  durationMin: number | null;
  speedMpm: number | null;
}

export function deriveRecord(record: TrainingRecord): DerivedRecord {
  const returned = record.homeAt.trim().length > 0;
  let durationMin: number | null = null;
  if (returned) {
    const ms =
      new Date(record.homeAt).getTime() - new Date(record.releaseAt).getTime();
    if (Number.isFinite(ms) && ms > 0) durationMin = Math.round(ms / 60000);
  }
  const speedMpm =
    returned && durationMin !== null && durationMin > 0
      ? (record.distanceKm * 1000) / durationMin
      : null;
  return {
    category: categoryOf(record.distanceKm),
    returned,
    durationMin,
    speedMpm,
  };
}

// ---------- 排行资格 ----------

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * 中长距离排行资格：
 * 已归巢、归巢时刻有效、健康正常、饲料/体重无短训限制；短训不进中长距离榜。
 */
export function rankingEligibility(
  record: TrainingRecord,
  pigeon: Pigeon | undefined,
  state: AppState,
): Eligibility {
  const d = deriveRecord(record);
  const reasons: string[] = [];

  if (!d.returned) reasons.push("未归巢，不参与排行");
  else if (d.durationMin === null) reasons.push("归巢时刻早于或等于放飞时刻");

  if (!pigeon) {
    reasons.push("赛鸽档案缺失");
  } else {
    if (pigeon.health !== "normal") reasons.push("健康异常，不参与排行");
    reasons.push(...shortOnlyReasons(pigeon, state.batches, state.pigeons));
  }

  if (d.category === "short") reasons.push("短训不进入中长距离排行");
  return { eligible: reasons.length === 0, reasons };
}

export interface RankRow {
  record: TrainingRecord;
  pigeon: Pigeon;
  speedMpm: number;
  durationMin: number;
}

/** 中长距离排行：只保留有资格的中/长训记录，按分速降序，参数更正后即时重算。 */
export function buildRanking(state: AppState): RankRow[] {
  const pigeonMap = new Map(state.pigeons.map((p) => [p.id, p]));
  const rows: RankRow[] = [];

  for (const record of state.records) {
    const d = deriveRecord(record);
    if (d.category === "short" || !d.returned || d.speedMpm === null) continue;
    const pigeon = pigeonMap.get(record.pigeonId);
    if (!pigeon || pigeon.health !== "normal") continue;
    if (shortOnlyReasons(pigeon, state.batches, state.pigeons).length > 0) {
      continue;
    }
    rows.push({
      record,
      pigeon,
      speedMpm: d.speedMpm,
      durationMin: d.durationMin as number,
    });
  }

  return rows.sort((a, b) => b.speedMpm - a.speedMpm);
}

export interface ExcludedRow {
  record: TrainingRecord;
  pigeon: Pigeon | undefined;
  reasons: string[];
}

/** 中/长距离但被排除在排行外的记录，用于公示排除原因。 */
export function buildExcluded(state: AppState): ExcludedRow[] {
  const pigeonMap = new Map(state.pigeons.map((p) => [p.id, p]));
  const rows: ExcludedRow[] = [];

  for (const record of state.records) {
    const d = deriveRecord(record);
    if (d.category === "short") continue;
    const pigeon = pigeonMap.get(record.pigeonId);
    const reasons: string[] = [];
    if (!d.returned) reasons.push("未归巢，不参与排行");
    else if (d.speedMpm === null) reasons.push("归巢时刻早于或等于放飞时刻");
    if (!pigeon) reasons.push("赛鸽档案缺失");
    else {
      if (pigeon.health !== "normal") reasons.push("健康异常，不参与排行");
      reasons.push(...shortOnlyReasons(pigeon, state.batches, state.pigeons));
    }
    if (reasons.length > 0) rows.push({ record, pigeon, reasons });
  }

  return rows.sort((a, b) =>
    (a.record.releaseAt || a.record.date).localeCompare(
      b.record.releaseAt || b.record.date,
    ),
  );
}

// ---------- 未归巢提醒 ----------

export interface MissingRow {
  record: TrainingRecord;
  pigeon: Pigeon | undefined;
  overdueLabel: string;
}

export function buildMissing(state: AppState, today: string): MissingRow[] {
  const pigeonMap = new Map(state.pigeons.map((p) => [p.id, p]));
  const rows = state.records
    .filter((r) => r.homeAt.trim() === "")
    .map((record) => ({
      record,
      pigeon: pigeonMap.get(record.pigeonId),
      overdueLabel: overdueLabel(record.date, today),
    }));
  return rows.sort((a, b) => a.record.releaseAt.localeCompare(b.record.releaseAt));
}

export function overdueLabel(date: string, today: string): string {
  const days = Math.round(
    (new Date(today).getTime() - new Date(date).getTime()) / 86_400_000,
  );
  if (days <= 0) return "今日放飞，待归巢";
  return `已滞留 ${days} 天`;
}

// ---------- 排训核验 ----------

export interface ScheduleInput {
  id?: string; // 更正时携带自身 id，避免和自己冲突
  pigeonId: string;
  date: string;
  distanceKm: number;
  releaseAt: string;
  homeAt: string; // 空串 = 未归巢
}

export interface ScheduleCheck {
  errors: string[];
  restrictions: string[]; // 当前赛鸽的短训限制（即使排的是短训也要提示）
  healthWarning: string | null;
}

/** 每羽同日只能排一次长训；受限赛鸽只能排短训。 */
export function checkSchedule(
  input: ScheduleInput,
  state: AppState,
): ScheduleCheck {
  const errors: string[] = [];
  const pigeon = state.pigeons.find((p) => p.id === input.pigeonId);
  const restrictions = pigeon
    ? shortOnlyReasons(pigeon, state.batches, state.pigeons)
    : ["赛鸽档案不存在"];
  const healthWarning =
    pigeon && pigeon.health !== "normal"
      ? "该羽健康异常：本次记录可登记，但不参与排行"
      : null;

  if (!input.date) errors.push("请选择训放日期");
  if (!pigeon) errors.push("请选择赛鸽");
  if (!Number.isFinite(input.distanceKm) || input.distanceKm <= 0) {
    errors.push("放飞距离必须为大于 0 的公里数");
  }

  if (pigeon && Number.isFinite(input.distanceKm) && input.distanceKm > 0) {
    const category = categoryOf(input.distanceKm);

    if (restrictions.length > 0 && category !== "short") {
      errors.push(
        `当前只允许短训（距离需 ＜ ${SHORT_LIMIT_KM}km）：${restrictions.join("；")}`,
      );
    }

    if (category === "long") {
      const duplicate = state.records.some(
        (r) =>
          r.id !== input.id &&
          r.pigeonId === pigeon.id &&
          r.date === input.date &&
          categoryOf(r.distanceKm) === "long",
      );
      if (duplicate) {
        errors.push("每羽同日只能排一次长训，该羽今日已有长训安排");
      }
    }
  }

  if (!input.releaseAt) {
    errors.push("请填写放飞时刻");
  }
  if (input.homeAt) {
    const ms =
      new Date(input.homeAt).getTime() - new Date(input.releaseAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
      errors.push("归巢时刻必须晚于放飞时刻");
    }
  }

  return { errors, restrictions, healthWarning };
}

// ---------- 展示格式化 ----------

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m} 分钟`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function formatSpeed(mpm: number): string {
  return `${Math.round(mpm * 10) / 10} m/min`;
}

export function formatHM(dateTime: string): string {
  return dateTime && dateTime.length >= 16 ? dateTime.slice(11, 16) : "--:--";
}
