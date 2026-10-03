import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";
export type RiskLevel = "低" | "中" | "高";
export type TripStatus = "待发" | "待定" | "已发车" | "已取消";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: RiskLevel;
  note: string;
  updatedAt: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: string[];
  note: string;
}

export interface PendingAction {
  id: string;
  action: string;
  detail: string;
  time: string;
}

/** 车站滞留客流上报。同一车站重复上报只认 reportedAt 更晚的一条 */
export interface PassengerReport {
  id: string;
  stationId: string;
  stranded: number;
  risk: RiskLevel;
  /** 业务上报时间（迟到补报会早于接收时间） */
  reportedAt: string;
  /** 到达系统时间 */
  receivedAt: string;
}

/** 接驳班次：未发车班次参与运力账排队，已发车班次冻结原占用 */
export interface ShuttleTrip {
  id: string;
  stationId: string;
  desk: string;
  /** 需求车辆数 */
  vehicles: number;
  /** 实际占用车队容量（待定/已取消为 0，已发车冻结） */
  allocated: number;
  status: TripStatus;
  /** 未发车班次在运力账中的排队位次 */
  queueIndex?: number;
  submittedAt: string;
  departedAt?: string;
}

export interface TripSubmitResult {
  ok: boolean;
  currentVersion: number;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  /** 接驳车队总量（固定） */
  fleetTotal: number;
  reports: PassengerReport[];
  trips: ShuttleTrip[];
  /** 每个车站的排车版本号，调度台提交排车做乐观并发校验 */
  stationLedger: Record<string, number>;
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
  submitReport: (stationId: string, stranded: number, risk: RiskLevel, lateMinutes?: number) => void;
  submitTrip: (stationId: string, vehicles: number, desk: string, baseVersion: number) => TripSubmitResult;
  departTrip: (id: string) => void;
  cancelTrip: (id: string) => void;
}

const now = () => new Date().toISOString();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

const seedReports: PassengerReport[] = [
  { id: "r1", stationId: "s1", stranded: 2600, risk: "高", reportedAt: minutesAgo(18), receivedAt: minutesAgo(18) },
  { id: "r2", stationId: "s2", stranded: 900, risk: "中", reportedAt: minutesAgo(15), receivedAt: minutesAgo(15) },
  { id: "r3", stationId: "s1", stranded: 3200, risk: "高", reportedAt: minutesAgo(6), receivedAt: minutesAgo(6) }
];

const seedTrips: ShuttleTrip[] = [
  { id: "t1", stationId: "s1", desk: "调度台A", vehicles: 6, allocated: 6, status: "已发车", submittedAt: minutesAgo(20), departedAt: minutesAgo(12) },
  { id: "t2", stationId: "s1", desk: "调度台B", vehicles: 8, allocated: 0, status: "待发", submittedAt: minutesAgo(9) },
  { id: "t3", stationId: "s2", desk: "调度台A", vehicles: 6, allocated: 0, status: "待发", submittedAt: minutesAgo(8) },
  { id: "t4", stationId: "s2", desk: "调度台B", vehicles: 4, allocated: 0, status: "待定", submittedAt: minutesAgo(5) }
];

export const riskWeight: Record<RiskLevel, number> = { 高: 0, 中: 1, 低: 2 };

/** 同一车站重复上报只认 reportedAt 更晚的一条（迟到旧报不覆盖新报） */
export function effectiveReports(reports: PassengerReport[]): Map<string, PassengerReport> {
  const map = new Map<string, PassengerReport>();
  for (const report of reports) {
    const prev = map.get(report.stationId);
    if (!prev || report.reportedAt > prev.reportedAt) map.set(report.stationId, report);
  }
  return map;
}

/**
 * 运力账重算：
 * - 已发车/已取消班次冻结，已发车保留原占用；
 * - 未发车班次按 风险等级 → 滞留人数 → 提交时间 排队，依次占用车队容量；
 * - 容量不足起，整队后续班次排队待定；
 * - 车站恢复“正常”的未发车班次自动取消，释放运力。
 */
export function allocateFleet(trips: ShuttleTrip[], reports: PassengerReport[], stations: Station[], fleetTotal: number): ShuttleTrip[] {
  const effective = effectiveReports(reports);
  const stationOf = (id: string) => stations.find((station) => station.id === id);
  const riskOf = (id: string): RiskLevel => effective.get(id)?.risk ?? stationOf(id)?.passengerRisk ?? "低";
  const strandedOf = (id: string) => effective.get(id)?.stranded ?? 0;

  let used = 0;
  const frozen = new Map<string, ShuttleTrip>();
  for (const trip of trips) {
    if (trip.status === "已发车" || trip.status === "已取消") {
      frozen.set(trip.id, trip);
      if (trip.status === "已发车") used += trip.allocated;
    }
  }

  const queue = trips
    .filter((trip) => !frozen.has(trip.id))
    .sort((a, b) =>
      riskWeight[riskOf(a.stationId)] - riskWeight[riskOf(b.stationId)] ||
      strandedOf(b.stationId) - strandedOf(a.stationId) ||
      a.submittedAt.localeCompare(b.submittedAt)
    );

  const settled = new Map<string, ShuttleTrip>();
  let blocked = false;
  let index = 0;
  for (const trip of queue) {
    index += 1;
    if (stationOf(trip.stationId)?.status === "正常") {
      settled.set(trip.id, { ...trip, status: "已取消", allocated: 0, queueIndex: undefined });
      continue;
    }
    if (!blocked && used + trip.vehicles <= fleetTotal) {
      used += trip.vehicles;
      settled.set(trip.id, { ...trip, status: "待发", allocated: trip.vehicles, queueIndex: index });
    } else {
      blocked = true;
      settled.set(trip.id, { ...trip, status: "待定", allocated: 0, queueIndex: index });
    }
  }
  return trips.map((trip) => frozen.get(trip.id) ?? settled.get(trip.id)!);
}

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: minutesAgo(35), section: "中心站—东港站" },
  stations: seedStations,
  timeline: [
    { id: "e1", time: minutesAgo(35), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: minutesAgo(27), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
  ],
  role: "调度员",
  online: true,
  pendingActions: [],
  fleetTotal: 20,
  reports: seedReports,
  trips: allocateFleet(seedTrips, seedReports, seedStations, 20),
  stationLedger: { s1: 2, s2: 2 },
  setRole: (role) => set({ role }),
  setOnline: (online) => set({ online }),
  setStationStatus: (id, status, note) => set((state) => {
    const stations = state.stations.map((station) => station.id === id ? { ...station, status, note: note ?? station.note, updatedAt: now() } : station);
    const name = stations.find((station) => station.id === id)?.name ?? id;
    return {
      stations,
      trips: allocateFleet(state.trips, state.reports, stations, state.fleetTotal),
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${name} → ${status}，未发车班次已按运力账重算`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" }, ...state.timeline],
      pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: "更新车站状态", detail: `${name} → ${status}`, time: now() }, ...state.pendingActions]
    };
  }),
  addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions] })),
  addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
  submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline] })),
  approvePlan: (id, approver) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan) })),
  executePlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "已执行" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline] })),
  queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), action, detail, time: now() }, ...state.pendingActions] })),
  syncActions: () => set({ pendingActions: [] }),
  submitReport: (stationId, stranded, risk, lateMinutes = 0) => set((state) => {
    const report: PassengerReport = {
      id: crypto.randomUUID(),
      stationId,
      stranded,
      risk,
      reportedAt: lateMinutes > 0 ? minutesAgo(lateMinutes) : now(),
      receivedAt: now()
    };
    const reports = [...state.reports, report];
    const name = state.stations.find((station) => station.id === stationId)?.name ?? stationId;
    const effective = effectiveReports(reports).get(stationId);
    const overridden = effective?.id !== report.id;
    return {
      reports,
      trips: allocateFleet(state.trips, reports, state.stations, state.fleetTotal),
      timeline: [{
        id: crypto.randomUUID(), time: now(), actor: state.role,
        action: lateMinutes > 0 ? "迟到客流上报" : "客流上报",
        detail: `${name} 滞留 ${stranded} 人（${risk}风险）${overridden ? "，该站已有更晚上报，此条被覆盖" : "，未发车班次已重排"}`,
        phase: "接驳"
      }, ...state.timeline]
    };
  }),
  submitTrip: (stationId, vehicles, desk, baseVersion) => {
    const state = get();
    const currentVersion = state.stationLedger[stationId] ?? 0;
    const name = state.stations.find((station) => station.id === stationId)?.name ?? stationId;
    if (currentVersion !== baseVersion) {
      set((prev) => ({
        timeline: [{ id: crypto.randomUUID(), time: now(), actor: prev.role, action: "排车冲突", detail: `${desk} 基于 v${baseVersion} 提交 ${name} 排车被拒，当前版本 v${currentVersion}，另一方已放行`, phase: "接驳" }, ...prev.timeline]
      }));
      return { ok: false, currentVersion };
    }
    const trip: ShuttleTrip = { id: crypto.randomUUID(), stationId, desk, vehicles, allocated: 0, status: "待定", submittedAt: now() };
    set((prev) => ({
      trips: allocateFleet([...prev.trips, trip], prev.reports, prev.stations, prev.fleetTotal),
      stationLedger: { ...prev.stationLedger, [stationId]: currentVersion + 1 },
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: prev.role, action: "提交排车", detail: `${desk} 为 ${name} 排 ${vehicles} 辆（版本 v${currentVersion} → v${currentVersion + 1}），已入运力账排队`, phase: "接驳" }, ...prev.timeline]
    }));
    return { ok: true, currentVersion: currentVersion + 1 };
  },
  departTrip: (id) => set((state) => {
    const target = state.trips.find((trip) => trip.id === id);
    if (!target || target.status !== "待发") return {};
    const name = state.stations.find((station) => station.id === target.stationId)?.name ?? target.stationId;
    return {
      trips: state.trips.map((trip) => trip.id === id ? { ...trip, status: "已发车" as TripStatus, departedAt: now(), queueIndex: undefined } : trip),
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "班次发车", detail: `${name} 班次发车，冻结占用 ${target.allocated} 辆`, phase: "接驳" }, ...state.timeline]
    };
  }),
  cancelTrip: (id) => set((state) => {
    const target = state.trips.find((trip) => trip.id === id);
    if (!target || target.status === "已发车" || target.status === "已取消") return {};
    const name = state.stations.find((station) => station.id === target.stationId)?.name ?? target.stationId;
    const trips = state.trips.map((trip) => trip.id === id ? { ...trip, status: "已取消" as TripStatus, allocated: 0, queueIndex: undefined } : trip);
    return {
      trips: allocateFleet(trips, state.reports, state.stations, state.fleetTotal),
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "取消班次", detail: `${name} 班次取消，释放运力并触发重算`, phase: "接驳" }, ...state.timeline]
    };
  })
}), { name: "pair-wise-yf-47/incident" }));
