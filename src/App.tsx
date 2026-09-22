import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  archiveRevision,
  loadFilters,
  loadState,
  nextId,
  saveFilters,
  saveState,
} from "./archive";
import {
  BATCH_STATE_LABEL,
  CATEGORY_LABEL,
  WEATHERS,
  batchStatus,
  buildExcluded,
  buildMissing,
  buildRanking,
  categoryOf,
  checkSchedule,
  countAssigned,
  deriveRecord,
  formatDuration,
  formatHM,
  formatSpeed,
  rankingEligibility,
  shortOnlyReasons,
  weightStatus,
  type AppState,
  type BatchState,
  type FeedBatch,
  type Filters,
  type Pigeon,
  type TrainingRecord,
} from "./rules";

const CATEGORY_FILTERS: { key: Filters["category"]; label: string }[] = [
  { key: "all", label: "全部距离" },
  { key: "short", label: "短训" },
  { key: "middle", label: "中距离" },
  { key: "long", label: "长距离" },
];

const KIND_LABEL = {
  record: "训放更正",
  pigeon: "档案更正",
  batch: "饲料更正",
} as const;

const SNAPSHOT_LABELS: Record<string, string> = {
  id: "编号",
  pigeonId: "赛鸽",
  date: "训放日期",
  location: "登记地点",
  distanceKm: "放飞距离(km)",
  weather: "天气",
  releaseAt: "放飞时刻",
  homeAt: "归巢时刻",
  rev: "版本号",
  ring: "足环号",
  bloodline: "血统",
  weightG: "体重(g)",
  minWeightG: "体重下限(g)",
  maxWeightG: "体重上限(g)",
  health: "健康状态",
  batchId: "饲料批次",
  name: "批次名称",
  active: "启用状态",
  rationG: "日粮标准(g)",
  stockG: "库存(g)",
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Draft {
  id: string | null;
  pigeonId: string;
  date: string;
  location: string;
  distanceKm: string;
  weather: string;
  releaseAt: string;
  homeAt: string; // 空串 = 未归巢
  returned: boolean;
}

const emptyDraft = (pigeonId: string): Draft => ({
  id: null,
  pigeonId,
  date: todayISO(),
  location: "",
  distanceKm: "",
  weather: "晴",
  releaseAt: "",
  homeAt: "",
  returned: true,
});

function recordToDraft(r: TrainingRecord): Draft {
  const returned = r.homeAt.length > 0;
  return {
    id: r.id,
    pigeonId: r.pigeonId,
    date: r.date,
    location: r.location,
    distanceKm: String(r.distanceKm),
    weather: r.weather,
    releaseAt: r.releaseAt,
    homeAt: r.homeAt,
    returned,
  };
}

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(""));
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);

  useEffect(() => saveState(state), [state]);
  useEffect(() => saveFilters(filters), [filters]);

  const pigeonMap = useMemo(
    () => new Map(state.pigeons.map((p) => [p.id, p])),
    [state.pigeons],
  );

  // 饲料 / 体重 / 放飞参数更正后，这里立即重算。
  const ranking = useMemo(() => buildRanking(state), [state]);
  const excluded = useMemo(() => buildExcluded(state), [state]);
  const missing = useMemo(
    () => buildMissing(state, todayISO()),
    [state],
  );

  const bloodlines = useMemo(
    () => Array.from(new Set(state.pigeons.map((p) => p.bloodline))),
    [state.pigeons],
  );

  const shortOnlyCount = state.pigeons.filter(
    (p) => shortOnlyReasons(p, state.batches, state.pigeons).length > 0,
  ).length;

  // ---------- 档案 / 批次更正：写入并归档旧版只读快照 ----------

  function patchPigeon<K extends keyof Pigeon>(
    id: string,
    key: K,
    value: Pigeon[K],
  ) {
    setState((prev) => {
      const old = prev.pigeons.find((p) => p.id === id);
      if (!old || old[key] === value) return prev;
      const label = SNAPSHOT_LABELS[key] ?? String(key);
      const rev = archiveRevision(
        "pigeon",
        old.id,
        `${old.ring} ${label}更正`,
        `${label}：${displayValue(old[key])} → ${displayValue(value)}（旧版只读，排行已重算）`,
        { ring: old.ring, field: String(key), oldValue: old[key], newValue: value },
      );
      return {
        ...prev,
        pigeons: prev.pigeons.map((p) =>
          p.id === id ? { ...p, [key]: value } : p,
        ),
        revisions: [rev, ...prev.revisions],
      };
    });
  }

  function patchBatch<K extends keyof FeedBatch>(
    id: string,
    key: K,
    value: FeedBatch[K],
  ) {
    setState((prev) => {
      const old = prev.batches.find((b) => b.id === id);
      if (!old || old[key] === value) return prev;
      const label = SNAPSHOT_LABELS[key] ?? String(key);
      const rev = archiveRevision(
        "batch",
        old.id,
        `批次「${old.name}」${label}更正`,
        `${label}：${displayValue(old[key])} → ${displayValue(value)}（旧版只读，核验与排行已重算）`,
        { name: old.name, field: String(key), oldValue: old[key], newValue: value },
      );
      return {
        ...prev,
        batches: prev.batches.map((b) =>
          b.id === id ? { ...b, [key]: value } : b,
        ),
        revisions: [rev, ...prev.revisions],
      };
    });
  }

  function saveDraft() {
    const distanceKm = parseFloat(draft.distanceKm);
    const check = checkSchedule(
      {
        id: draft.id ?? undefined,
        pigeonId: draft.pigeonId,
        date: draft.date,
        distanceKm,
        releaseAt: draft.releaseAt,
        homeAt: draft.returned ? draft.homeAt : "",
      },
      state,
    );
    setFormErrors(check.errors);
    if (check.errors.length > 0) return;

    setState((prev) => {
      if (draft.id) {
        const old = prev.records.find((r) => r.id === draft.id);
        if (!old) return prev;
        const updated: TrainingRecord = {
          ...old,
          pigeonId: draft.pigeonId,
          date: draft.date,
          location: draft.location.trim() || "未填写地点",
          distanceKm,
          weather: draft.weather,
          releaseAt: draft.releaseAt,
          homeAt: draft.returned ? draft.homeAt : "",
          rev: old.rev + 1,
        };
        const rev = archiveRevision(
          "record",
          old.id,
          `${pigeonMap.get(old.pigeonId)?.ring ?? old.pigeonId} 训放参数更正 v${old.rev}→v${updated.rev}`,
          "放飞参数已更正，排行与未归巢提醒立即重算；旧版只读留存。",
          { ...old },
        );
        return {
          ...prev,
          records: prev.records.map((r) => (r.id === old.id ? updated : r)),
          revisions: [rev, ...prev.revisions],
        };
      }

      const pigeon = prev.pigeons.find((p) => p.id === draft.pigeonId);
      const created: TrainingRecord = {
        id: nextId("r"),
        pigeonId: draft.pigeonId,
        date: draft.date,
        location: draft.location.trim() || "未填写地点",
        distanceKm,
        weather: draft.weather,
        releaseAt: draft.releaseAt,
        homeAt: draft.returned ? draft.homeAt : "",
        rev: 1,
      };
      return {
        ...prev,
        records: [...prev.records, created],
        revisions: [
          archiveRevision(
            "record",
            created.id,
            `${pigeon?.ring ?? created.pigeonId} 训放登记`,
            `${draft.date} ${created.location} ${distanceKm}km，${
              created.homeAt ? "已归巢" : "未归巢"
            }`,
            { ...created },
          ),
          ...prev.revisions,
        ],
      };
    });

    setDraft(emptyDraft(draft.pigeonId));
    setFormErrors([]);
  }

  function startEdit(record: TrainingRecord) {
    setDraft(recordToDraft(record));
    setFormErrors([]);
    document.getElementById("register")?.scrollIntoView({ behavior: "smooth" });
  }

  // ---------- 筛选（刷新后仍保留） ----------

  const visibleRecords = useMemo(() => {
    return state.records
      .filter((r) => {
        const pigeon = pigeonMap.get(r.pigeonId);
        if (
          filters.bloodline !== "全部" &&
          (!pigeon || pigeon.bloodline !== filters.bloodline)
        ) {
          return false;
        }
        if (
          filters.category !== "all" &&
          categoryOf(r.distanceKm) !== filters.category
        ) {
          return false;
        }
        if (filters.missingOnly && r.homeAt.length > 0) return false;
        return true;
      })
      .sort((a, b) => b.releaseAt.localeCompare(a.releaseAt));
  }, [state.records, pigeonMap, filters]);

  const profilePigeon = profileId ? pigeonMap.get(profileId) ?? null : null;

  return (
    <main className="app">
      <section className="hero">
        <p>离线核验台 · 数据仅存本机浏览器 · Port 62014</p>
        <h1>赛鸽训放与饲料批次核验台</h1>
        <span>
          饲料停用、日粮不足或体重偏离区间的赛鸽只能短训，不进入中长距离排行；每羽同日只能排一次长训；
          未归巢与健康异常不参与排行。更正饲料、体重或放飞参数后，排行与未归巢提醒立即重算，旧版只读归档。
        </span>
        <nav className="nav">
          <a href="#batch">饲料批次核验</a>
          <a href="#loft">鸽棚档案</a>
          <a href="#register">训放登记</a>
          <a href="#records">训放记录</a>
          <a href="#ranking">中长距离排行</a>
          <a href="#missing">未归巢提醒</a>
          <a href="#archive">修订存档</a>
        </nav>
      </section>

      <section className="metrics">
        <Metric label="在棚羽数" value={state.pigeons.length} suffix="羽" />
        <Metric label="未归巢" value={missing.length} suffix="羽" tone={missing.length > 0 ? "warn" : undefined} />
        <Metric label="中长距上榜" value={ranking.length} suffix="条" />
        <Metric label="短训受限" value={shortOnlyCount} suffix="羽" tone={shortOnlyCount > 0 ? "warn" : undefined} />
      </section>

      <BatchPanel
        state={state}
        onPatch={patchBatch}
      />

      <section className="workspace" id="loft">
        <aside className="panel">
          <p className="eyebrow">筛选与档案</p>
          <h2>鸽棚总览</h2>
          <div className="chips">
            {["全部", ...bloodlines].map((b) => (
              <button
                key={b}
                className={filters.bloodline === b ? "chip-on" : ""}
                onClick={() => setFilters((f) => ({ ...f, bloodline: b }))}
              >
                {b}
              </button>
            ))}
          </div>
          <div className="chips" style={{ marginTop: 10 }}>
            {CATEGORY_FILTERS.map((c) => (
              <button
                key={c.key}
                className={filters.category === c.key ? "chip-on" : ""}
                onClick={() => setFilters((f) => ({ ...f, category: c.key }))}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="checkline">
            <input
              type="checkbox"
              checked={filters.missingOnly}
              onChange={(e) =>
                setFilters((f) => ({ ...f, missingOnly: e.target.checked }))
              }
            />
            <span>只看未归巢记录</span>
          </label>
        </aside>

        <section className="panel">
          <div className="heading">
            <div>
              <p className="eyebrow">单羽档案 · 点击卡片查看履历</p>
              <h2>赛鸽档案（{state.pigeons.length}）</h2>
            </div>
          </div>
          <div className="loft-grid">
            {state.pigeons
              .filter(
                (p) =>
                  filters.bloodline === "全部" ||
                  p.bloodline === filters.bloodline,
              )
              .map((p) => (
                <PigeonCard
                  key={p.id}
                  pigeon={p}
                  batches={state.batches}
                  allPigeons={state.pigeons}
                  onOpen={() => setProfileId(p.id)}
                  onPatch={(key, value) => patchPigeon(p.id, key, value)}
                />
              ))}
          </div>
        </section>
      </section>

      <section className="panel" id="register">
        <div className="heading">
          <div>
            <p className="eyebrow">登记地点 · 距离 · 天气 · 放飞/归巢时刻</p>
            <h2>{draft.id ? `更正训放记录（v 已归档）` : "训放登记"}</h2>
          </div>
          {draft.id && (
            <button onClick={() => { setDraft(emptyDraft(draft.pigeonId)); setFormErrors([]); }}>
              改为新增登记
            </button>
          )}
        </div>
        <RegisterForm
          draft={draft}
          setDraft={setDraft}
          state={state}
          onSave={saveDraft}
          errors={formErrors}
        />
      </section>

      <section className="panel" id="records">
        <div className="heading">
          <div>
            <p className="eyebrow">列表随筛选条件与档案/参数更正实时一致</p>
            <h2>训放记录（{visibleRecords.length}）</h2>
          </div>
        </div>
        <RecordsTable
          records={visibleRecords}
          state={state}
          onEdit={startEdit}
        />
      </section>

      <section className="split-panels">
        <section className="panel" id="ranking">
          <p className="eyebrow">仅统计已归巢、健康正常、无短训限制的中/长训</p>
          <h2>中长距离排行</h2>
          <RankingPanel ranking={ranking} excluded={excluded} />
        </section>
        <section className="panel" id="missing">
          <p className="eyebrow">未归巢或健康异常鸽不参与排行</p>
          <h2>未归巢提醒（{missing.length}）</h2>
          <MissingPanel missing={missing} onLocate={startEdit} />
        </section>
      </section>

      <section className="panel" id="archive">
        <p className="eyebrow">旧版只读 · 每次更正均留存快照</p>
        <h2>修订存档（{state.revisions.length}）</h2>
        <div className="revisions">
          {state.revisions.map((rev) => (
            <article key={rev.id} className="revision">
              <header>
                <span className={`kind kind-${rev.kind}`}>{KIND_LABEL[rev.kind]}</span>
                <b>{rev.title}</b>
                <time>{new Date(rev.at).toLocaleString("zh-CN", { hour12: false })}</time>
              </header>
              <p>{rev.note}</p>
              <dl className="snapshot">
                {Object.entries(rev.snapshot).map(([k, v]) => (
                  <div key={k}>
                    <dt>{SNAPSHOT_LABELS[k] ?? k}</dt>
                    <dd>{snapshotText(k, v, state)}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </section>

      {profilePigeon && (
        <ProfileModal
          pigeon={profilePigeon}
          state={state}
          onClose={() => setProfileId(null)}
        />
      )}
    </main>
  );
}

// ---------- 小组件 ----------

function Metric({
  label,
  value,
  suffix,
  tone,
}: {
  label: string;
  value: number;
  suffix: string;
  tone?: "warn";
}) {
  return (
    <article className={tone === "warn" ? "metric-warn" : ""}>
      <small>{label}</small>
      <strong>
        {value}
        <em>{suffix}</em>
      </strong>
    </article>
  );
}

function BatchPanel({
  state,
  onPatch,
}: {
  state: AppState;
  onPatch: <K extends keyof FeedBatch>(id: string, key: K, value: FeedBatch[K]) => void;
}) {
  return (
    <section className="panel" id="batch">
      <div className="heading">
        <div>
          <p className="eyebrow">停用批次 / 日粮不足的绑定鸽只能短训</p>
          <h2>饲料批次核验</h2>
        </div>
      </div>
      <div className="batch-grid">
        {state.batches.map((b) => {
          const assigned = countAssigned(b.id, state.pigeons);
          const demand = assigned * b.rationG;
          const status: BatchState = batchStatus(b, assigned);
          return (
            <article key={b.id} className={`batch-card batch-${status}`}>
              <header>
                <b>{b.name}</b>
                <span className={`state state-${status}`}>{BATCH_STATE_LABEL[status]}</span>
              </header>
              <dl>
                <div>
                  <dt>分配羽数</dt>
                  <dd>{assigned} 羽</dd>
                </div>
                <div>
                  <dt>当日需求</dt>
                  <dd>{demand} g</dd>
                </div>
                <div>
                  <dt>库存</dt>
                  <dd>
                    <NumInput
                      value={b.stockG}
                      onCommit={(v) => onPatch(b.id, "stockG", v)}
                    />{" "}
                    g
                  </dd>
                </div>
                <div>
                  <dt>日粮标准</dt>
                  <dd>
                    <NumInput
                      value={b.rationG}
                      onCommit={(v) => onPatch(b.id, "rationG", v)}
                    />{" "}
                    g/羽
                  </dd>
                </div>
              </dl>
              <label className="switch-line">
                <input
                  type="checkbox"
                  checked={b.active}
                  onChange={(e) => onPatch(b.id, "active", e.target.checked)}
                />
                <span>{b.active ? "启用中（勾选取消即停用）" : "已停用（勾选恢复启用）"}</span>
              </label>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PigeonCard({
  pigeon,
  batches,
  allPigeons,
  onOpen,
  onPatch,
}: {
  pigeon: Pigeon;
  batches: FeedBatch[];
  allPigeons: Pigeon[];
  onOpen: () => void;
  onPatch: <K extends keyof Pigeon>(key: K, value: Pigeon[K]) => void;
}) {
  const ws = weightStatus(pigeon);
  const reasons = shortOnlyReasons(pigeon, batches, allPigeons);
  const restricted = reasons.length > 0;
  return (
    <article className={`pigeon-card ${restricted ? "is-restricted" : ""} ${pigeon.health === "abnormal" ? "is-sick" : ""}`}>
      <button className="card-head" onClick={onOpen}>
        <b>{pigeon.ring}</b>
        <span className="tag">{pigeon.bloodline}</span>
        {pigeon.health === "abnormal" && <span className="tag tag-danger">健康异常</span>}
        {restricted && <span className="tag tag-warn">仅可短训</span>}
      </button>
      <dl className="kv">
        <div>
          <dt>体重</dt>
          <dd>
            <NumInput
              value={pigeon.weightG}
              onCommit={(v) => onPatch("weightG", v)}
            />
            <small className={ws === "ok" ? "" : "text-warn"}>
              {" "}g · 区间 {pigeon.minWeightG}–{pigeon.maxWeightG}
              {ws === "low" && "（偏低）"}
              {ws === "high" && "（偏高）"}
            </small>
          </dd>
        </div>
        <div>
          <dt>健康</dt>
          <dd>
            <select
              value={pigeon.health}
              onChange={(e) => onPatch("health", e.target.value as Pigeon["health"])}
            >
              <option value="normal">正常</option>
              <option value="abnormal">异常</option>
            </select>
          </dd>
        </div>
        <div>
          <dt>饲料批次</dt>
          <dd>
            <select
              value={pigeon.batchId}
              onChange={(e) => onPatch("batchId", e.target.value)}
            >
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {!b.active ? "（停用）" : ""}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div>
          <dt>血统</dt>
          <dd>
            <input
              defaultValue={pigeon.bloodline}
              onBlur={(e) => onPatch("bloodline", e.target.value.trim() || pigeon.bloodline)}
            />
          </dd>
        </div>
      </dl>
      {restricted && (
        <ul className="reason-list">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function NumInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="num-input"
      type="number"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = parseFloat(text);
        if (Number.isFinite(v)) onCommit(v);
        else setText(String(value));
      }}
    />
  );
}

function RegisterForm({
  draft,
  setDraft,
  state,
  onSave,
  errors,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  state: AppState;
  onSave: () => void;
  errors: string[];
}) {
  const pigeon = state.pigeons.find((p) => p.id === draft.pigeonId);
  const restrictions = pigeon
    ? shortOnlyReasons(pigeon, state.batches, state.pigeons)
    : [];
  const distance = parseFloat(draft.distanceKm);
  const previewCat = Number.isFinite(distance) && distance > 0 ? categoryOf(distance) : null;

  return (
    <div>
      <div className="field-grid">
        <label>
          <span>赛鸽（足环号）</span>
          <select
            value={draft.pigeonId}
            onChange={(e) => setDraft((d) => ({ ...d, pigeonId: e.target.value }))}
          >
            <option value="">请选择赛鸽</option>
            {state.pigeons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.ring} · {p.bloodline}
                {p.health === "abnormal" ? " · 健康异常" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>训放日期</span>
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
          />
        </label>
        <label>
          <span>登记地点</span>
          <input
            placeholder="如：沧州西站"
            value={draft.location}
            onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
          />
        </label>
        <label>
          <span>放飞距离（km）{previewCat && `· 判定：${CATEGORY_LABEL[previewCat]}`}</span>
          <input
            type="number"
            min="1"
            placeholder={restrictions.length > 0 ? "当前仅允许 ＜ 80km 短训" : "如：220"}
            value={draft.distanceKm}
            onChange={(e) => setDraft((d) => ({ ...d, distanceKm: e.target.value }))}
          />
        </label>
        <label>
          <span>天气</span>
          <select
            value={draft.weather}
            onChange={(e) => setDraft((d) => ({ ...d, weather: e.target.value }))}
          >
            {WEATHERS.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </label>
        <label>
          <span>放飞时刻</span>
          <input
            type="datetime-local"
            value={draft.releaseAt}
            onChange={(e) => setDraft((d) => ({ ...d, releaseAt: e.target.value }))}
          />
        </label>
        <label className="span-2">
          <span className="checkline">
            <input
              type="checkbox"
              checked={draft.returned}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  returned: e.target.checked,
                  homeAt: e.target.checked ? d.homeAt : "",
                }))
              }
            />
            已归巢（取消勾选即登记为未归巢，进入未归巢提醒、不参与排行）
          </span>
          {draft.returned && (
            <input
              type="datetime-local"
              value={draft.homeAt}
              onChange={(e) => setDraft((d) => ({ ...d, homeAt: e.target.value }))}
            />
          )}
        </label>
      </div>

      {pigeon && restrictions.length > 0 && (
        <ul className="reason-list">
          {restrictions.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {pigeon && pigeon.health === "abnormal" && (
        <p className="form-warn">健康异常：本次训放可登记，但不进入任何排行。</p>
      )}
      {errors.length > 0 && (
        <ul className="error-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        <button className="primary" onClick={onSave}>
          {draft.id ? "更正并重算排行" : "保存登记"}
        </button>
        <small>保存后写入本机存档；更正操作会把旧版快照存入修订存档（只读）。</small>
      </div>
    </div>
  );
}

function RecordsTable({
  records,
  state,
  onEdit,
}: {
  records: TrainingRecord[];
  state: AppState;
  onEdit: (r: TrainingRecord) => void;
}) {
  const pigeonMap = new Map(state.pigeons.map((p) => [p.id, p]));
  if (records.length === 0) {
    return <p className="empty">没有符合筛选条件的训放记录。</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>足环号 / 血统</th>
            <th>地点</th>
            <th>距离</th>
            <th>天气</th>
            <th>放飞</th>
            <th>归巢 / 用时</th>
            <th>分速</th>
            <th>排行资格</th>
            <th>版本</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const pigeon = pigeonMap.get(r.pigeonId);
            const d = deriveRecord(r);
            const elig = rankingEligibility(r, pigeon, state);
            return (
              <tr key={r.id} className={!d.returned ? "row-missing" : ""}>
                <td>{r.date}</td>
                <td>
                  <b>{pigeon?.ring ?? r.pigeonId}</b>
                  <small>{pigeon?.bloodline ?? "档案缺失"}</small>
                </td>
                <td>{r.location}</td>
                <td>
                  {r.distanceKm}km
                  <span className={`cat cat-${d.category}`}>{CATEGORY_LABEL[d.category]}</span>
                </td>
                <td>{r.weather}</td>
                <td>{formatHM(r.releaseAt)}</td>
                <td>
                  {d.returned ? (
                    <>
                      {formatHM(r.homeAt)}
                      <small>{d.durationMin !== null ? formatDuration(d.durationMin) : "时刻异常"}</small>
                    </>
                  ) : (
                    <span className="text-danger">未归巢</span>
                  )}
                </td>
                <td>{d.speedMpm !== null ? formatSpeed(d.speedMpm) : "—"}</td>
                <td>
                  {d.category === "short" ? (
                    <span className="muted">短训不参评</span>
                  ) : elig.eligible ? (
                    <span className="tag tag-ok">可参评</span>
                  ) : (
                    <ul className="mini-reasons">
                      {elig.reasons.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>v{r.rev}</td>
                <td>
                  <button className="btn-sm" onClick={() => onEdit(r)}>更正</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RankingPanel({
  ranking,
  excluded,
}: {
  ranking: ReturnType<typeof buildRanking>;
  excluded: ReturnType<typeof buildExcluded>;
}) {
  return (
    <div>
      {ranking.length === 0 ? (
        <p className="empty">暂无符合资格的中长距离成绩。</p>
      ) : (
        <ol className="rank-list">
          {ranking.map((row, i) => (
            <li key={row.record.id}>
              <span className={`rank-no ${i < 3 ? `rank-top-${i + 1}` : ""}`}>{i + 1}</span>
              <div>
                <b>{row.pigeon.ring}</b>
                <small>
                  {row.pigeon.bloodline} · {row.record.date} · {row.record.location} ·{" "}
                  {row.record.distanceKm}km（{CATEGORY_LABEL[categoryOf(row.record.distanceKm)]}）·{" "}
                  {row.record.weather}
                </small>
              </div>
              <div className="rank-speed">
                <b>{formatSpeed(row.speedMpm)}</b>
                <small>用时 {formatDuration(row.durationMin)}</small>
              </div>
            </li>
          ))}
        </ol>
      )}
      <h3 className="subhead">未上榜中长训记录（{excluded.length}）</h3>
      {excluded.length === 0 ? (
        <p className="empty">无。</p>
      ) : (
        <ul className="excluded-list">
          {excluded.map((x) => (
            <li key={x.record.id}>
              <b>{x.pigeon?.ring ?? x.record.pigeonId}</b>
              <span>
                {x.record.date} · {x.record.location} · {x.record.distanceKm}km
              </span>
              <small>{x.reasons.join("；")}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MissingPanel({
  missing,
  onLocate,
}: {
  missing: ReturnType<typeof buildMissing>;
  onLocate: (r: TrainingRecord) => void;
}) {
  if (missing.length === 0) {
    return <p className="empty">全部归巢，暂无提醒。</p>;
  }
  return (
    <ul className="missing-list">
      {missing.map(({ record, pigeon, overdueLabel }) => (
        <li key={record.id}>
          <div>
            <b>{pigeon?.ring ?? record.pigeonId}</b>
            {pigeon?.health === "abnormal" && (
              <span className="tag tag-danger">健康异常</span>
            )}
            <small>
              {record.date} {formatHM(record.releaseAt)} 放飞 · {record.location} ·{" "}
              {record.distanceKm}km · {record.weather}
            </small>
            <span className="overdue">{overdueLabel}</span>
          </div>
          <button className="btn-sm" onClick={() => onLocate(record)}>补录归巢</button>
        </li>
      ))}
    </ul>
  );
}

function ProfileModal({
  pigeon,
  state,
  onClose,
}: {
  pigeon: Pigeon;
  state: AppState;
  onClose: () => void;
}) {
  const records = state.records
    .filter((r) => r.pigeonId === pigeon.id)
    .sort((a, b) => b.releaseAt.localeCompare(a.releaseAt));
  const reasons = shortOnlyReasons(pigeon, state.batches, state.pigeons);
  const batch = state.batches.find((b) => b.id === pigeon.batchId);
  const longDays = new Set(
    records
      .filter((r) => categoryOf(r.distanceKm) === "long")
      .map((r) => r.date),
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <section className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="heading">
          <div>
            <p className="eyebrow">单羽赛鸽档案</p>
            <h2>{pigeon.ring} · {pigeon.bloodline}</h2>
          </div>
          <button className="btn-sm" onClick={onClose}>关闭</button>
        </div>
        <dl className="profile-meta">
          <div><dt>体重区间</dt><dd>{pigeon.minWeightG}–{pigeon.maxWeightG} g（当前 {pigeon.weightG} g）</dd></div>
          <div><dt>健康状态</dt><dd>{pigeon.health === "normal" ? "正常" : "异常（不参与排行）"}</dd></div>
          <div><dt>饲料批次</dt><dd>{batch?.name ?? "未绑定"}{batch && !batch.active ? "（停用）" : ""}</dd></div>
          <div><dt>长训日期</dt><dd>{longDays.size ? Array.from(longDays).sort().join("、") : "暂无"}（每日至多一次）</dd></div>
        </dl>
        {reasons.length > 0 && (
          <ul className="reason-list">
            {reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        <h3 className="subhead">历史成绩（{records.length}）</h3>
        <ul className="history-list">
          {records.map((r) => {
            const d = deriveRecord(r);
            const elig = rankingEligibility(r, pigeon, state);
            return (
              <li key={r.id}>
                <span>{r.date} · {r.location} · {r.distanceKm}km（{CATEGORY_LABEL[d.category]}）· {r.weather}</span>
                <small>
                  {d.returned
                    ? `${formatHM(r.homeAt)} 归巢 · ${d.durationMin !== null ? formatDuration(d.durationMin) : "时刻异常"}${
                        d.speedMpm !== null ? ` · ${formatSpeed(d.speedMpm)}` : ""
                      }`
                    : "未归巢"}
                  {d.category !== "short" && !elig.eligible && ` · 不上榜：${elig.reasons.join("；")}`}
                  {d.category === "short" && " · 短训不参评"}
                </small>
              </li>
            );
          })}
          {records.length === 0 && <li className="empty">暂无训放记录。</li>}
        </ul>
      </section>
    </div>
  );
}

// ---------- 展示辅助 ----------

function displayValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "启用/正常" : "停用/异常";
  return String(v);
}

function snapshotText(key: string, value: unknown, state: AppState): string {
  if (key === "pigeonId" && typeof value === "string") {
    return state.pigeons.find((p) => p.id === value)?.ring ?? value;
  }
  if (key === "batchId" && typeof value === "string") {
    return state.batches.find((b) => b.id === value)?.name ?? value;
  }
  if (key === "homeAt" && value === "") return "未归巢";
  if (key === "health") return value === "normal" ? "正常" : "异常";
  if (key === "active") return value ? "启用" : "停用";
  if (typeof value === "string" && value.length >= 16 && value.includes("T")) {
    return value.replace("T", " ");
  }
  return String(value);
}

export default App;
