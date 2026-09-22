// 业务规则层：纯函数，不依赖 React 与 localStorage。
// 距离分级、饲料批次核验、排训限制、排行与未归巢判定全部集中在此。

export type Tier = "short" | "middle" | "long";

export const TIER_LABEL: Record<Tier, string> = {
  short: "短距离",
  middle: "中距离",
  long: "长距离",
};

export const TIER_ORDER: Tier[] = ["short", "middle", "long"];

// 距离区间（km）：短训 ≤ 100；中训 101–300；长训 > 300。
export const SHORT_MAX_KM = 100;
export const MIDDLE_MAX_KM = 300;

export type Health = "normal" | "abnormal";

export const HEALTH_LABEL: Record<Health, string> = {
  normal: "健康正常",
  abnormal: "健康异常",
};

export type BatchStatus = "active" | "inactive";

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  active: "启用",
  inactive: "停用",
};

export interface FeedBatch {
  id: string;
  code: string; // 饲料批号
  name: string;
  status: BatchStatus;
  stockKg: number; // 批次余量（日粮，kg）
}

export interface Pigeon {
  id: string;
  ringNo: string; // 足环号
  bloodline: string; // 血统
  weightG: number; // 最近一次体重（克）
  weightMinG: number; // 体重区间下限
  weightMaxG: number; // 体重区间上限
  health: Health;
  batchId: string; // 关联饲料批次
  pairing?: string; // 配对记录
}

export type FlightOutcome = "homed" | "missing";

// 一次登记（含更正）的不可变版本。
export interface FlightVersion {
  version: number;
  at: string; // 版本生成时间（ISO）
  location: string; // 训放地点
  distanceKm: number; // 放飞距离
  weather: string; // 天气
  releasedAt: string; // 放飞时刻（datetime-local）
  homedAt: string; // 归巢时刻（datetime-local，未归巢为空）
  durationMin: number; // 用时（分钟，可手工核录，0 表示未核录）
  outcome: FlightOutcome;
  reason?: string; // 更正说明
}

export interface Flight {
  id: string;
  pigeonId: string;
  date: string; // 训放日 YYYY-MM-DD
  versions: FlightVersion[];
  // 登记/最近更正时刻的核验快照，便于事后追溯。
  snapshot: {
    batchCode: string;
    batchStatus: BatchStatus;
    stockKg: number;
    weightG: number;
    health: Health;
  };
}

export interface Archive {
  batches: FeedBatch[];
  pigeons: Pigeon[];
  flights: Flight[];
}

export interface ViewState {
  tab: string;
  tier: Tier | "all";
  bloodline: string;
  selectedPigeonId: string;
}

export const WEATHER_OPTIONS = ["晴", "多云", "阴", "小雨", "侧风", "逆风", "大雾"];

// ---------- 基础判定 ----------

export function tierOf(distanceKm: number): Tier {
  if (distanceKm <= SHORT_MAX_KM) return "short";
  if (distanceKm <= MIDDLE_MAX_KM) return "middle";
  return "long";
}

export function diffMinutes(from: string, to: string): number {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 60000) : 0;
}

export function formatDuration(min: number): string {
  if (min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}

export function speedMps(distanceKm: number, durationMin: number): number {
  if (distanceKm <= 0 || durationMin <= 0) return 0;
  return (distanceKm * 1000) / (durationMin * 60);
}

export function weightStatusOf(p: Pigeon): "ok" | "deviate" {
  return p.weightG >= p.weightMinG && p.weightG <= p.weightMaxG ? "ok" : "deviate";
}

export function batchOf(archive: Archive, batchId: string): FeedBatch | undefined {
  return archive.batches.find((b) => b.id === batchId);
}

export function pigeonOf(archive: Archive, id: string): Pigeon | undefined {
  return archive.pigeons.find((p) => p.id === id);
}

export function bloodlines(archive: Archive): string[] {
  return Array.from(new Set(archive.pigeons.map((p) => p.bloodline))).sort();
}

// ---------- 饲料批次核验 ----------

export type GateCode = "batchMissing" | "batchInactive" | "rationLow" | "weightDeviate" | "healthAbnormal";

export interface Gate {
  code: GateCode;
  label: string;
}

// 日粮不足：批次余量低于每羽每次训放 0.05kg 的最低补给线。
export const RATION_PER_FLIGHT_KG = 0.05;

export function feedGates(archive: Archive, p: Pigeon): Gate[] {
  const gates: Gate[] = [];
  const batch = batchOf(archive, p.batchId);
  if (!batch) {
    gates.push({ code: "batchMissing", label: "未关联饲料批次" });
    return gates;
  }
  if (batch.status === "inactive") gates.push({ code: "batchInactive", label: `饲料批次「${batch.code}」已停用` });
  if (batch.stockKg < RATION_PER_FLIGHT_KG) gates.push({ code: "rationLow", label: `日粮不足（余量 ${batch.stockKg}kg）` });
  return gates;
}

export function conditionGates(archive: Archive, p: Pigeon): Gate[] {
  const gates = feedGates(archive, p);
  if (weightStatusOf(p) === "deviate") {
    gates.push({
      code: "weightDeviate",
      label: `体重偏离区间（${p.weightMinG}–${p.weightMaxG}g，当前 ${p.weightG}g）`,
    });
  }
  if (p.health === "abnormal") gates.push({ code: "healthAbnormal", label: "健康异常" });
  return gates;
}

// ---------- 排训判定 ----------

export interface ScheduleVerdict {
  tier: Tier;
  allowedTier: Tier; // 满足条件可排的最高级别
  gates: Gate[]; // 全部条件问题
  longBooked: boolean; // 当日是否已排过长训
  canBook: boolean; // 当前参数能否登记该次训放
  messages: string[]; // 阻断/降级原因
}

export function hasLongFlightOnDate(archive: Archive, pigeonId: string, date: string): boolean {
  return archive.flights.some(
    (f) => f.pigeonId === pigeonId && f.date === date && tierOf(f.versions[f.versions.length - 1].distanceKm) === "long"
  );
}

// 中长距离准入：短训无条件可排；中训受饲料/日粮/体重/健康限制；
// 长训额外受「每羽同日只能排一次长训」限制。
export function scheduleVerdict(
  archive: Archive,
  p: Pigeon,
  date: string,
  distanceKm: number,
  excludeFlightId?: string
): ScheduleVerdict {
  const gates = conditionGates(archive, p);
  const longBooked = archive.flights.some(
    (f) =>
      f.id !== excludeFlightId &&
      f.pigeonId === p.id &&
      f.date === date &&
      tierOf(f.versions[f.versions.length - 1].distanceKm) === "long"
  );

  const allowedTier: Tier = gates.length > 0 ? "short" : "long";
  const tier = tierOf(distanceKm);
  const messages: string[] = gates.map((g) => g.label);
  if (longBooked) messages.push("当日已排过一次长训");

  const blockedByCondition = tier !== "short" && gates.length > 0;
  const blockedByLongOnce = tier === "long" && longBooked;

  return {
    tier,
    allowedTier,
    gates,
    longBooked,
    canBook: !blockedByCondition && !blockedByLongOnce,
    messages,
  };
}

// ---------- 排行与未归巢 ----------

export interface RankRow {
  flight: Flight;
  version: FlightVersion;
  pigeon: Pigeon;
  tier: Tier;
  speed: number; // m/s
  eligible: boolean;
  excludes: Gate[];
  longBooked: boolean;
}

// 排行榜资格即时重算：以当前饲料、体重、健康与最新版本参数为准。
export function rankRows(
  archive: Archive,
  opts: { tier?: Tier | "all"; bloodline?: string } = {}
): RankRow[] {
  const rows: RankRow[] = archive.flights.map((flight) => {
    const version = flight.versions[flight.versions.length - 1];
    const pigeon = pigeonOf(archive, flight.pigeonId)!;
    const tier = tierOf(version.distanceKm);
    const excludes = conditionGates(archive, pigeon);
    const longBooked = archive.flights.some(
      (f) =>
        f.id !== flight.id &&
        f.pigeonId === flight.pigeonId &&
        f.date === flight.date &&
        tierOf(f.versions[f.versions.length - 1].distanceKm) === "long"
    );
    return {
      flight,
      version,
      pigeon,
      tier,
      speed: version.outcome === "homed" ? speedMps(version.distanceKm, version.durationMin) : 0,
      eligible:
        version.outcome === "homed" &&
        excludes.length === 0 &&
        !(tier === "long" && longBooked) &&
        version.durationMin > 0,
      excludes,
      longBooked: tier === "long" && longBooked,
    };
  });

  return rows
    .filter((r) => (opts.tier ? opts.tier === "all" || r.tier === opts.tier : true))
    .filter((r) => (opts.bloodline ? r.pigeon.bloodline === opts.bloodline : true))
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return b.speed - a.speed;
    });
}

export function missingFlights(archive: Archive): { flight: Flight; version: FlightVersion; pigeon: Pigeon; days: number }[] {
  const now = Date.now();
  return archive.flights
    .map((f) => ({ flight: f, version: f.versions[f.versions.length - 1], pigeon: pigeonOf(archive, f.pigeonId)! }))
    .filter((x) => x.version.outcome === "missing")
    .map((x) => ({
      ...x,
      days: Math.max(0, Math.floor((now - new Date(x.version.releasedAt).getTime()) / 86400000)),
    }))
    .sort((a, b) => new Date(a.version.releasedAt).getTime() - new Date(b.version.releasedAt).getTime());
}

export interface LoftStats {
  pigeonCount: number;
  flightCount: number;
  homedRate: number; // 最新版本归巢率（%）
  avgSpeed: number; // 有合格用时的归巢鸽均速（m/s）
  missingCount: number;
  alertCount: number; // 饲料/体重/健康条件受限鸽羽数
}

export function loftStats(archive: Archive): LoftStats {
  const latest = archive.flights.map((f) => f.versions[f.versions.length - 1]);
  const homed = latest.filter((v) => v.outcome === "homed").length;
  const timed = latest.filter((v) => v.outcome === "homed" && v.durationMin > 0);
  const avgSpeed =
    timed.length > 0
      ? timed.reduce((sum, v) => sum + speedMps(v.distanceKm, v.durationMin), 0) / timed.length
      : 0;
  const alertPigeons = new Set(archive.pigeons.filter((p) => conditionGates(archive, p).length > 0).map((p) => p.id));
  return {
    pigeonCount: archive.pigeons.length,
    flightCount: archive.flights.length,
    homedRate: latest.length ? Math.round((homed / latest.length) * 100) : 0,
    avgSpeed,
    missingCount: latest.filter((v) => v.outcome === "missing").length,
    alertCount: alertPigeons.size,
  };
}

export function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
