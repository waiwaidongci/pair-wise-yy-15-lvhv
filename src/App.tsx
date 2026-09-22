import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  Archive,
  BATCH_STATUS_LABEL,
  FeedBatch,
  Flight,
  HEALTH_LABEL,
  Health,
  Pigeon,
  RankRow,
  TIER_LABEL,
  TIER_ORDER,
  Tier,
  ViewState,
  WEATHER_OPTIONS,
  conditionGates,
  diffMinutes,
  formatDuration,
  loftStats,
  missingFlights,
  pigeonOf,
  rankRows,
  scheduleVerdict,
  speedMps,
  tierOf,
  todayStr,
  bloodlines,
  weightStatusOf,
} from "./rules";
import {
  FlightDraft,
  addFlight,
  exportArchive,
  importArchive,
  loadArchive,
  loadView,
  nextId,
  resetArchive,
  reviseFlight,
  saveArchive,
  saveView,
  upsertBatch,
  upsertPigeon,
} from "./archive";

const TABS = [
  { key: "overview", label: "鸽棚总览" },
  { key: "book", label: "训放登记/更正" },
  { key: "rank", label: "成绩排行" },
  { key: "loft", label: "鸽舍档案" },
  { key: "feed", label: "饲料批次核验" },
] as const;

interface FormState {
  mode: "create" | "revise";
  flightId?: string;
  pigeonId: string;
  date: string;
  location: string;
  distanceText: string;
  weather: string;
  releasedAt: string;
  homedAt: string;
  durationText: string;
  outcome: "homed" | "missing";
  reason: string;
}

const emptyForm = (pigeonId: string): FormState => ({
  mode: "create",
  pigeonId,
  date: todayStr(),
  location: "",
  distanceText: "",
  weather: WEATHER_OPTIONS[0],
  releasedAt: "",
  homedAt: "",
  durationText: "",
  outcome: "homed",
  reason: "",
});

function timeLabel(dt: string): string {
  if (!dt) return "—";
  const [d, t] = dt.split("T");
  return `${d?.slice(5) ?? ""} ${t ?? ""}`.trim();
}

function App() {
  const [archive, setArchive] = useState<Archive>(loadArchive);
  const [view, setView] = useState<ViewState>(loadView);
  const [form, setForm] = useState<FormState>(() => emptyForm(loadArchive().pigeons[0]?.id ?? ""));
  const [formError, setFormError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 任何变更即写本地存档；筛选/标签页一并持久化，刷新后一致。
  useEffect(() => saveArchive(archive), [archive]);
  useEffect(() => saveView(view), [view]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  const stats = useMemo(() => loftStats(archive), [archive]);
  const lines = useMemo(() => bloodlines(archive), [archive]);
  const rows = useMemo(
    () => rankRows(archive, { tier: view.tier, bloodline: view.bloodline }),
    [archive, view.tier, view.bloodline]
  );
  const missing = useMemo(() => missingFlights(archive), [archive]);
  const selectedPigeon = archive.pigeons.find((p) => p.id === view.selectedPigeonId) ?? archive.pigeons[0];

  const patchForm = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // 用时可手填，也可用放飞/归巢时刻自动核算。
  const syncDuration = (releasedAt: string, homedAt: string, outcome: "homed" | "missing") => {
    if (outcome !== "homed") return;
    const min = diffMinutes(releasedAt, homedAt);
    if (min > 0) patchForm({ durationText: String(min) });
  };

  const startRevise = (flight: Flight) => {
    const v = flight.versions[flight.versions.length - 1];
    setForm({
      mode: "revise",
      flightId: flight.id,
      pigeonId: flight.pigeonId,
      date: flight.date,
      location: v.location,
      distanceText: String(v.distanceKm),
      weather: v.weather,
      releasedAt: v.releasedAt,
      homedAt: v.homedAt,
      durationText: v.durationMin ? String(v.durationMin) : "",
      outcome: v.outcome,
      reason: "",
    });
    setFormError("");
    setView((w) => ({ ...w, tab: "book" }));
  };

  const submitFlight = () => {
    const p = archive.pigeons.find((x) => x.id === form.pigeonId);
    const distance = Number(form.distanceText);
    if (!p) return setFormError("请选择赛鸽");
    if (!form.date) return setFormError("请选择训放日期");
    if (!form.location.trim()) return setFormError("请登记训放地点");
    if (!(distance > 0)) return setFormError("请填写正确的放飞距离（km）");
    if (!form.releasedAt) return setFormError("请填写放飞时刻");
    if (form.outcome === "homed" && (!form.homedAt || !(Number(form.durationText) > 0))) {
      return setFormError("归巢鸽需登记归巢时刻与用时");
    }
    if (form.outcome === "homed" && diffMinutes(form.releasedAt, form.homedAt) < 0) {
      return setFormError("归巢时刻不能早于放飞时刻");
    }

    const verdict = scheduleVerdict(
      archive,
      p,
      form.date,
      distance,
      form.mode === "revise" ? form.flightId : undefined
    );
    if (!verdict.canBook) {
      const tip =
        verdict.tier !== "short"
          ? `当前仅可安排短训（≤100km），${TIER_LABEL[verdict.tier]}不予登记。`
          : "";
      return setFormError([...verdict.messages, tip].filter(Boolean).join("；"));
    }
    if (form.mode === "revise" && !form.reason.trim()) {
      return setFormError("更正需填写更正说明（旧版只读留档）");
    }

    const draft: FlightDraft = {
      pigeonId: form.pigeonId,
      date: form.date,
      location: form.location,
      distanceKm: distance,
      weather: form.weather,
      releasedAt: form.releasedAt,
      homedAt: form.homedAt,
      durationMin: Number(form.durationText) || 0,
      outcome: form.outcome,
      reason: form.reason,
    };
    setArchive((a) =>
      form.mode === "revise" && form.flightId ? reviseFlight(a, form.flightId, draft) : addFlight(a, draft)
    );
    setNotice(form.mode === "revise" ? "已生成新版本，排行与未归巢提醒已重算" : "训放已登记，排行与提醒已重算");
    setForm(emptyForm(form.pigeonId));
    setFormError("");
  };

  const onImport = (file: File | undefined) => {
    if (!file) return;
    importArchive(file)
      .then((next) => {
        setArchive(next);
        setNotice("存档已导入");
      })
      .catch((e: Error) => setFormError(e.message));
  };

  return (
    <main className="app">
      <header className="hero">
        <p>离线工作台 · hxyfront-62014</p>
        <h1>赛鸽训放与饲料批次核验台</h1>
        <span>
          每羽同日仅可排一次长训；饲料批次停用、日粮不足或体重偏离区间时只可短训，不得进入中长距离排行。
          未归巢与健康异常鸽不参与排行；饲料、体重或放飞参数更正后，排行与未归巢提醒立即重算，旧版只读。
        </span>
        <div className="hero-tools">
          <button onClick={() => exportArchive(archive)}>导出存档</button>
          <button onClick={() => fileRef.current?.click()}>导入存档</button>
          <button
            onClick={() => {
              if (confirm("恢复为演示数据？当前本地存档将被覆盖。")) {
                setArchive(resetArchive());
                setNotice("已恢复演示数据");
              }
            }}
          >
            恢复演示数据
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => onImport(e.target.files?.[0])}
          />
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={view.tab === t.key ? "active" : ""}
            onClick={() => setView((w) => ({ ...w, tab: t.key }))}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {notice && <div className="toast">{notice}</div>}

      {view.tab === "overview" && (
        <Overview archive={archive} stats={stats} missing={missing} onRevise={startRevise} />
      )}

      {view.tab === "book" && (
        <section className="panel workspace-grid">
          <div>
            <div className="heading">
              <div>
                <p>登记地点 / 距离 / 天气 / 归巢时刻与用时</p>
                <h2>{form.mode === "revise" ? `更正训放（${form.flightId?.slice(-6)}，旧版只读）` : "新增训放登记"}</h2>
              </div>
              {form.mode === "revise" && (
                <button onClick={() => setForm(emptyForm(form.pigeonId))}>取消更正</button>
              )}
            </div>
            <BookForm
              archive={archive}
              form={form}
              patch={patchForm}
              syncDuration={syncDuration}
              onSubmit={submitFlight}
            />
            {formError && <p className="error">{formError}</p>}
          </div>
          <BookingVerdict archive={archive} form={form} />
        </section>
      )}

      {view.tab === "rank" && (
        <RankBoard
          archive={archive}
          rows={rows}
          view={view}
          lines={lines}
          onTier={(tier) => setView((w) => ({ ...w, tier }))}
          onBloodline={(bloodline) => setView((w) => ({ ...w, bloodline }))}
          onRevise={startRevise}
        />
      )}

      {view.tab === "loft" && (
        <LoftTab
          archive={archive}
          selected={selectedPigeon}
          onSelect={(id) => setView((w) => ({ ...w, selectedPigeonId: id }))}
          onSave={(p) => {
            setArchive((a) => upsertPigeon(a, p));
            setNotice("赛鸽档案已更正，排行立即重算");
          }}
          onAdd={(p) => {
            setArchive((a) => upsertPigeon(a, p));
            setNotice("新鸽已入棚");
          }}
          onRevise={startRevise}
        />
      )}

      {view.tab === "feed" && (
        <FeedTab
          archive={archive}
          onSaveBatch={(b) => {
            setArchive((a) => upsertBatch(a, b));
          }}
        />
      )}
    </main>
  );
}

// ---------- 总览 ----------

function Overview({
  archive,
  stats,
  missing,
  onRevise,
}: {
  archive: Archive;
  stats: ReturnType<typeof loftStats>;
  missing: ReturnType<typeof missingFlights>;
  onRevise: (f: Flight) => void;
}) {
  const restricted = archive.pigeons
    .map((p) => ({ p, gates: conditionGates(archive, p) }))
    .filter((x) => x.gates.length > 0);
  const recent = [...archive.flights]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);

  return (
    <>
      <section className="metrics">
        <article>
          <small>归巢率（最新版本）</small>
          <strong>{stats.homedRate}%</strong>
        </article>
        <article>
          <small>归巢平均速度</small>
          <strong>{stats.avgSpeed ? stats.avgSpeed.toFixed(2) : "—"}</strong>
          <em>m/s</em>
        </article>
        <article>
          <small>未归巢提醒</small>
          <strong className={stats.missingCount ? "warn-text" : ""}>{stats.missingCount}</strong>
          <em>羽/次</em>
        </article>
        <article>
          <small>条件受限（仅可短训）</small>
          <strong className={stats.alertCount ? "warn-text" : ""}>{stats.alertCount}</strong>
          <em>羽 · 在棚 {stats.pigeonCount}</em>
        </article>
      </section>

      <section className="panel alert-panel">
        <div className="heading">
          <div>
            <p>放飞后未归巢</p>
            <h2>未归巢提醒（不参与排行）</h2>
          </div>
        </div>
        {missing.length === 0 ? (
          <p className="muted">暂无未归巢记录。</p>
        ) : (
          <div className="records">
            {missing.map(({ flight, version, pigeon, days }) => (
              <article key={flight.id} className="alert-card">
                <b>!</b>
                <div>
                  <h3>
                    {pigeon.ringNo} · {version.location} · {version.distanceKm}km（{TIER_LABEL[tierOf(version.distanceKm)]}）
                  </h3>
                  <p>
                    {pigeon.bloodline} · 天气 {version.weather} · 放飞 {timeLabel(version.releasedAt)} · 已失联{" "}
                    {days} 天 · {flight.versions.length > 1 && `第 ${version.version} 版 · `}
                    {flight.date}
                  </p>
                </div>
                <button onClick={() => onRevise(flight)}>归巢补录/更正</button>
              </article>
            ))}
          </div>
        )}
      </section>

      {restricted.length > 0 && (
        <section className="panel alert-panel">
          <div className="heading">
            <div>
              <p>饲料批次 / 体重核验</p>
              <h2>以下赛鸽当前仅可安排短训</h2>
            </div>
          </div>
          <ul className="gate-list">
            {restricted.map(({ p, gates }) => (
              <li key={p.id}>
                <b>{p.ringNo}</b>
                <span className="muted">{p.bloodline}</span>
                {gates.map((g) => (
                  <i key={g.code} className="gate-tag">
                    {g.label}
                  </i>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="heading">
          <div>
            <p>近期训放</p>
            <h2>工作台摘要（共 {stats.flightCount} 次）</h2>
          </div>
        </div>
        <FlightTable flights={recent} archive={archive} onRevise={onRevise} />
      </section>
    </>
  );
}

// ---------- 登记表单 + 实时核验 ----------

function BookForm({
  archive,
  form,
  patch,
  syncDuration,
  onSubmit,
}: {
  archive: Archive;
  form: FormState;
  patch: (p: Partial<FormState>) => void;
  syncDuration: (r: string, h: string, o: "homed" | "missing") => void;
  onSubmit: () => void;
}) {
  return (
    <div className="field-grid">
      <label>
        <span>赛鸽（足环号）</span>
        <select value={form.pigeonId} onChange={(e) => patch({ pigeonId: e.target.value })}>
          {archive.pigeons.map((p) => (
            <option key={p.id} value={p.id}>
              {p.ringNo} · {p.bloodline}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>训放日期</span>
        <input type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} />
      </label>
      <label>
        <span>训放地点</span>
        <input value={form.location} placeholder="如：新乡" onChange={(e) => patch({ location: e.target.value })} />
      </label>
      <label>
        <span>放飞距离（km）</span>
        <input
          type="number"
          min={1}
          value={form.distanceText}
          placeholder="≤100 短训 / 101–300 中训 / >300 长训"
          onChange={(e) => patch({ distanceText: e.target.value })}
        />
      </label>
      <label>
        <span>天气</span>
        <select value={form.weather} onChange={(e) => patch({ weather: e.target.value })}>
          {WEATHER_OPTIONS.map((w) => (
            <option key={w}>{w}</option>
          ))}
        </select>
      </label>
      <label>
        <span>放飞时刻</span>
        <input
          type="datetime-local"
          value={form.releasedAt}
          onChange={(e) => {
            patch({ releasedAt: e.target.value });
            syncDuration(e.target.value, form.homedAt, form.outcome);
          }}
        />
      </label>
      <label>
        <span>归巢情况</span>
        <select
          value={form.outcome}
          onChange={(e) => patch({ outcome: e.target.value as "homed" | "missing" })}
        >
          <option value="homed">已归巢</option>
          <option value="missing">未归巢</option>
        </select>
      </label>
      {form.outcome === "homed" ? (
        <>
          <label>
            <span>归巢时刻</span>
            <input
              type="datetime-local"
              value={form.homedAt}
              onChange={(e) => {
                patch({ homedAt: e.target.value });
                syncDuration(form.releasedAt, e.target.value, form.outcome);
              }}
            />
          </label>
          <label>
            <span>飞行用时（分钟）</span>
            <input
              type="number"
              min={1}
              value={form.durationText}
              placeholder="可按时刻自动核算后手改"
              onChange={(e) => patch({ durationText: e.target.value })}
            />
          </label>
        </>
      ) : (
        <p className="muted span-2">未归巢鸽进入提醒列表，不参与排行；归巢后可用「归巢补录/更正」生成新版本。</p>
      )}
      {form.mode === "revise" && (
        <label className="span-2">
          <span>更正说明（必填，旧版只读留档）</span>
          <input value={form.reason} placeholder="如：GPS 复核实际空距 / 补录归巢时刻" onChange={(e) => patch({ reason: e.target.value })} />
        </label>
      )}
      <div className="span-2">
        <button className="primary" onClick={onSubmit}>
          {form.mode === "revise" ? "提交更正并生成新版本" : "保存登记"}
        </button>
      </div>
    </div>
  );
}

function BookingVerdict({ archive, form }: { archive: Archive; form: FormState }) {
  const p = archive.pigeons.find((x) => x.id === form.pigeonId);
  const distance = Number(form.distanceText);
  const verdict = useMemo(
    () => (p && form.date && distance > 0 ? scheduleVerdict(archive, p, form.date, distance, form.mode === "revise" ? form.flightId : undefined) : null),
    [archive, p, form.date, distance, form.mode, form.flightId]
  );
  if (!p || !verdict) return <aside className="panel verdict-panel muted">填写日期与距离后显示排训核验结果。</aside>;

  const batch = archive.batches.find((b) => b.id === p.batchId);
  return (
    <aside className="panel verdict-panel">
      <h2>实时核验</h2>
      <dl className="kv">
        <dt>足环号 / 血统</dt>
        <dd>{p.ringNo} · {p.bloodline}</dd>
        <dt>饲料批次</dt>
        <dd>
          {batch ? `${batch.code}（${BATCH_STATUS_LABEL[batch.status]}，余量 ${batch.stockKg}kg）` : "未关联"}
        </dd>
        <dt>体重</dt>
        <dd>
          {p.weightG}g（区间 {p.weightMinG}–{p.weightMaxG}g）
          {weightStatusOf(p) === "deviate" && <i className="gate-tag">偏离</i>}
        </dd>
        <dt>健康</dt>
        <dd>{HEALTH_LABEL[p.health]}</dd>
        <dt>本次档次</dt>
        <dd>
          {TIER_LABEL[verdict.tier]}
          {verdict.longBooked && <i className="gate-tag">当日已排长训</i>}
        </dd>
      </dl>
      <div className={verdict.canBook ? "verdict ok" : "verdict block"}>
        {verdict.canBook ? (
          <>✓ 可登记本次{TIER_LABEL[verdict.tier]}训放{verdict.tier === "long" && "（当日长训名额仅此一次）"}</>
        ) : (
          <>
            ✕ 不予登记{TIER_LABEL[verdict.tier]}：
            <ul>{verdict.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
            仅可安排短训（≤100km），且不得进入中长距离排行。
          </>
        )}
      </div>
    </aside>
  );
}

// ---------- 排行榜 ----------

function RankBoard({
  archive,
  rows,
  view,
  lines,
  onTier,
  onBloodline,
  onRevise,
}: {
  archive: Archive;
  rows: RankRow[];
  view: ViewState;
  lines: string[];
  onTier: (t: Tier | "all") => void;
  onBloodline: (b: string) => void;
  onRevise: (f: Flight) => void;
}) {
  const eligible = rows.filter((r) => r.eligible);
  const excluded = rows.filter((r) => !r.eligible);
  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>按均速排序 · 资格随饲料/体重/健康与放飞参数即时重算</p>
          <h2>训放成绩排行</h2>
        </div>
      </div>
      <div className="filters">
        {(["all", ...TIER_ORDER] as (Tier | "all")[]).map((t) => (
          <button key={t} className={view.tier === t ? "active" : ""} onClick={() => onTier(t)}>
            {t === "all" ? "全部距离" : TIER_LABEL[t]}
          </button>
        ))}
        <span className="filter-sep">|</span>
        <button className={view.bloodline === "" ? "active" : ""} onClick={() => onBloodline("")}>
          全部血统
        </button>
        {lines.map((b) => (
          <button key={b} className={view.bloodline === b ? "active" : ""} onClick={() => onBloodline(b)}>
            {b}
          </button>
        ))}
      </div>

      <table className="grid-table">
        <thead>
          <tr>
            <th>名次</th><th>足环号</th><th>血统</th><th>地点</th><th>距离/档次</th>
            <th>天气</th><th>放飞时刻</th><th>归巢时刻</th><th>用时</th><th>均速</th><th>版本</th><th></th>
          </tr>
        </thead>
        <tbody>
          {eligible.map((r, i) => (
            <tr key={r.flight.id}>
              <td><b className="rank-no">{i + 1}</b></td>
              <td>{r.pigeon.ringNo}</td>
              <td>{r.pigeon.bloodline}</td>
              <td>{r.version.location}</td>
              <td>{r.version.distanceKm}km · {TIER_LABEL[r.tier]}</td>
              <td>{r.version.weather}</td>
              <td>{timeLabel(r.version.releasedAt)}</td>
              <td>{timeLabel(r.version.homedAt)}</td>
              <td>{formatDuration(r.version.durationMin)}</td>
              <td>{r.speed.toFixed(2)} m/s</td>
              <td><VersionBadge flight={r.flight} /></td>
              <td><button onClick={() => onRevise(r.flight)}>更正</button></td>
            </tr>
          ))}
          {eligible.length === 0 && (
            <tr><td colSpan={12} className="muted">当前筛选下暂无上榜记录。</td></tr>
          )}
        </tbody>
      </table>

      <h3 className="subhead">不参与排行的记录（{excluded.length}）</h3>
      <table className="grid-table muted-table">
        <thead>
          <tr><th>足环号</th><th>血统</th><th>地点/距离</th><th>排除原因</th><th>版本</th><th></th></tr>
        </thead>
        <tbody>
          {excluded.map((r) => (
            <tr key={r.flight.id}>
              <td>{r.pigeon.ringNo}</td>
              <td>{r.pigeon.bloodline}</td>
              <td>{r.version.location} · {r.version.distanceKm}km（{TIER_LABEL[r.tier]}）</td>
              <td>
                {r.version.outcome === "missing" && <i className="gate-tag">未归巢</i>}
                {r.longBooked && <i className="gate-tag">同日重复长训</i>}
                {r.excludes.map((g) => <i key={g.code} className="gate-tag">{g.label}</i>)}
                {r.version.outcome === "homed" && r.version.durationMin <= 0 && <i className="gate-tag">未核录用时</i>}
              </td>
              <td><VersionBadge flight={r.flight} /></td>
              <td><button onClick={() => onRevise(r.flight)}>更正</button></td>
            </tr>
          ))}
          {excluded.length === 0 && (
            <tr><td colSpan={6} className="muted">无排除记录。</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function VersionBadge({ flight }: { flight: Flight }) {
  const v = flight.versions[flight.versions.length - 1];
  const last = flight.versions[flight.versions.length - 1];
  return (
    <span className="ver-badge" title={last.reason ?? "初版登记"}>
      v{v.version}
      {flight.versions.length > 1 && <em>（旧版只读{v.reason ? `：${v.reason}` : ""}）</em>}
    </span>
  );
}

// ---------- 鸽舍档案 ----------

function LoftTab({
  archive,
  selected,
  onSelect,
  onSave,
  onAdd,
  onRevise,
}: {
  archive: Archive;
  selected: Pigeon | undefined;
  onSelect: (id: string) => void;
  onSave: (p: Pigeon) => void;
  onAdd: (p: Pigeon) => void;
  onRevise: (f: Flight) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="workspace-grid loft-grid">
      <aside className="panel">
        <div className="heading">
          <h2>鸽舍名册</h2>
          <button onClick={() => setAdding((x) => !x)}>{adding ? "收起" : "新鸽入棚"}</button>
        </div>
        {adding && <PigeonEditor archive={archive} onDone={(p) => { onAdd(p); setAdding(false); }} />}
        <ul className="pigeon-list">
          {archive.pigeons.map((p) => {
            const gates = conditionGates(archive, p);
            return (
              <li key={p.id} className={selected?.id === p.id ? "active" : ""} onClick={() => onSelect(p.id)}>
                <b>{p.ringNo}</b>
                <span>{p.bloodline}</span>
                {p.health === "abnormal" && <i className="dot dot-warn" title="健康异常" />}
                {gates.some((g) => g.code !== "healthAbnormal") && <i className="dot dot-feed" title="饲料/体重受限" />}
              </li>
            );
          })}
        </ul>
      </aside>
      {selected && <PigeonProfile archive={archive} pigeon={selected} onSave={onSave} onRevise={onRevise} />}
    </section>
  );
}

function PigeonProfile({
  archive,
  pigeon,
  onSave,
  onRevise,
}: {
  archive: Archive;
  pigeon: Pigeon;
  onSave: (p: Pigeon) => void;
  onRevise: (f: Flight) => void;
}) {
  const [draft, setDraft] = useState<Pigeon>(pigeon);
  useEffect(() => setDraft(pigeon), [pigeon.id, archive]);
  const gates = conditionGates(archive, pigeon);
  const history = archive.flights
    .filter((f) => f.pigeonId === pigeon.id)
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>单羽档案 · 体重/健康/批次更正后排行立即重算</p>
          <h2>{pigeon.ringNo}</h2>
        </div>
        <button className="primary" onClick={() => onSave(draft)}>保存档案更正</button>
      </div>
      {gates.length > 0 && (
        <div className="verdict block">
          当前仅可短训：{gates.map((g) => g.label).join("；")}
        </div>
      )}
      <div className="field-grid">
        <label>
          <span>足环号</span>
          <input value={draft.ringNo} onChange={(e) => setDraft({ ...draft, ringNo: e.target.value })} />
        </label>
        <label>
          <span>血统</span>
          <input value={draft.bloodline} onChange={(e) => setDraft({ ...draft, bloodline: e.target.value })} />
        </label>
        <label>
          <span>体重（g）</span>
          <input type="number" value={draft.weightG} onChange={(e) => setDraft({ ...draft, weightG: Number(e.target.value) })} />
        </label>
        <label>
          <span>体重区间下限（g）</span>
          <input type="number" value={draft.weightMinG} onChange={(e) => setDraft({ ...draft, weightMinG: Number(e.target.value) })} />
        </label>
        <label>
          <span>体重区间上限（g）</span>
          <input type="number" value={draft.weightMaxG} onChange={(e) => setDraft({ ...draft, weightMaxG: Number(e.target.value) })} />
        </label>
        <label>
          <span>健康状态</span>
          <select value={draft.health} onChange={(e) => setDraft({ ...draft, health: e.target.value as Health })}>
            <option value="normal">{HEALTH_LABEL.normal}</option>
            <option value="abnormal">{HEALTH_LABEL.abnormal}</option>
          </select>
        </label>
        <label>
          <span>饲料批次</span>
          <select value={draft.batchId} onChange={(e) => setDraft({ ...draft, batchId: e.target.value })}>
            {archive.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {b.name}（{BATCH_STATUS_LABEL[b.status]}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>配对记录</span>
          <input value={draft.pairing ?? ""} onChange={(e) => setDraft({ ...draft, pairing: e.target.value })} />
        </label>
      </div>

      <h3 className="subhead">该羽历史成绩（{history.length}）</h3>
      <FlightTable flights={history} archive={archive} onRevise={onRevise} compact />
    </div>
  );
}

function PigeonEditor({ archive, onDone }: { archive: Archive; onDone: (p: Pigeon) => void }) {
  const [draft, setDraft] = useState<Pigeon>({
    id: nextId("p"),
    ringNo: "",
    bloodline: "",
    weightG: 450,
    weightMinG: 420,
    weightMaxG: 500,
    health: "normal",
    batchId: archive.batches[0]?.id ?? "",
  });
  return (
    <div className="inline-form">
      <input placeholder="足环号" value={draft.ringNo} onChange={(e) => setDraft({ ...draft, ringNo: e.target.value })} />
      <input placeholder="血统" value={draft.bloodline} onChange={(e) => setDraft({ ...draft, bloodline: e.target.value })} />
      <input placeholder="体重 g" type="number" value={draft.weightG} onChange={(e) => setDraft({ ...draft, weightG: Number(e.target.value) })} />
      <button
        className="primary"
        onClick={() => {
          if (!draft.ringNo.trim() || !draft.bloodline.trim()) return;
          onDone(draft);
        }}
      >
        入棚
      </button>
    </div>
  );
}

// ---------- 饲料批次 ----------

function FeedTab({ archive, onSaveBatch }: { archive: Archive; onSaveBatch: (b: FeedBatch) => void }) {
  const [draft, setDraft] = useState<Omit<FeedBatch, "id">>({
    code: "",
    name: "",
    status: "active",
    stockKg: 0,
  });
  return (
    <section className="workspace-grid feed-grid">
      <div className="panel">
        <div className="heading">
          <div>
            <p>停用 / 日粮不足的批次关联鸽只能短训，更正后立即重算排行</p>
            <h2>饲料批次核验</h2>
          </div>
        </div>
        {archive.batches.map((b) => {
          const users = archive.pigeons.filter((p) => p.batchId === b.id);
          const low = b.stockKg < 0.05;
          return (
            <article key={b.id} className={`batch-card ${b.status === "inactive" ? "is-off" : ""} ${low && b.status === "active" ? "is-low" : ""}`}>
              <div className="batch-head">
                <input
                  className="batch-code"
                  value={b.code}
                  onChange={(e) => onSaveBatch({ ...b, code: e.target.value })}
                />
                <input
                  className="batch-name"
                  value={b.name}
                  onChange={(e) => onSaveBatch({ ...b, name: e.target.value })}
                />
                <button
                  className={b.status === "active" ? "" : "primary"}
                  onClick={() => onSaveBatch({ ...b, status: b.status === "active" ? "inactive" : "active" })}
                >
                  {b.status === "active" ? "停用批次" : "重新启用"}
                </button>
              </div>
              <label className="stock-line">
                <span>日粮余量（kg，低于 0.05kg 判定不足）</span>
                <input
                  type="number"
                  step={0.01}
                  min={0}
                  value={b.stockKg}
                  onChange={(e) => onSaveBatch({ ...b, stockKg: Math.max(0, Number(e.target.value)) })}
                />
              </label>
              <p className="muted">
                状态：{BATCH_STATUS_LABEL[b.status]}
                {b.status === "inactive" && <i className="gate-tag">已停用</i>}
                {low && b.status === "active" && <i className="gate-tag">日粮不足</i>}
                {" "}· 关联 {users.length} 羽：
                {users.map((u) => (
                  <i key={u.id} className="ring-tag">{u.ringNo}</i>
                ))}
              </p>
            </article>
          );
        })}

        <h3 className="subhead">新增批次</h3>
        <div className="inline-form">
          <input placeholder="批号，如 FD-2026-0922" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          <input placeholder="名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="余量 kg" type="number" step={0.01} value={draft.stockKg} onChange={(e) => setDraft({ ...draft, stockKg: Number(e.target.value) })} />
          <button
            className="primary"
            onClick={() => {
              if (!draft.code.trim()) return;
              onSaveBatch({ ...draft, id: nextId("b"), code: draft.code.trim() });
              setDraft({ code: "", name: "", status: "active", stockKg: 0 });
            }}
          >
            增加批次
          </button>
        </div>
      </div>

      <aside className="panel">
        <h2>批次核验结果</h2>
        <ul className="gate-list">
          {archive.pigeons.map((p) => {
            const gates = conditionGates(archive, p);
            return (
              <li key={p.id}>
                <b>{p.ringNo}</b>
                <span className="muted">{p.bloodline}</span>
                {gates.length === 0 ? (
                  <i className="ok-tag">中长训准入正常</i>
                ) : (
                  gates.map((g) => <i key={g.code} className="gate-tag">{g.label}</i>)
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    </section>
  );
}

// ---------- 通用表格 ----------

function FlightTable({
  flights,
  archive,
  onRevise,
  compact,
}: {
  flights: Flight[];
  archive: Archive;
  onRevise: (f: Flight) => void;
  compact?: boolean;
}) {
  if (flights.length === 0) return <p className="muted">暂无记录。</p>;
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th>日期</th><th>足环号</th>{!compact && <th>血统</th>}<th>地点</th><th>距离/档次</th>
          <th>天气</th><th>放飞</th><th>归巢</th><th>用时/均速</th><th>版本</th><th></th>
        </tr>
      </thead>
      <tbody>
        {flights.map((f) => {
          const v = f.versions[f.versions.length - 1];
          const p = pigeonOf(archive, f.pigeonId);
          return (
            <tr key={f.id} className={v.outcome === "missing" ? "row-missing" : ""}>
              <td>{f.date}</td>
              <td>{p?.ringNo}</td>
              {!compact && <td>{p?.bloodline}</td>}
              <td>{v.location}</td>
              <td>{v.distanceKm}km · {TIER_LABEL[tierOf(v.distanceKm)]}</td>
              <td>{v.weather}</td>
              <td>{timeLabel(v.releasedAt)}</td>
              <td>{v.outcome === "missing" ? <i className="gate-tag">未归巢</i> : timeLabel(v.homedAt)}</td>
              <td>
                {v.outcome === "homed"
                  ? `${formatDuration(v.durationMin)} · ${v.durationMin > 0 ? speedMps(v.distanceKm, v.durationMin).toFixed(2) : "—"} m/s`
                  : "—"}
              </td>
              <td><VersionBadge flight={f} /></td>
              <td><button onClick={() => onRevise(f)}>更正</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default App;
