import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  FLEET_TOTAL,
  recomputeCapacity,
  scheduleTrip as scheduleTripPure,
  departTrip as departTripPure,
  type PassengerReport,
  type RiskLevel,
  type ScheduleResult,
  type ShuttleTrip
} from "../lib/capacity";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

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
  /** 排车版本号：每次成功排车 +1，用于两个调度台同时提交时的乐观并发控制 */
  scheduleVersion: number;
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

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  /** 客流上报（同一车站重复上报只认更晚的一条，见 latestReports） */
  reports: PassengerReport[];
  /** 接驳班次台账（运力账） */
  trips: ShuttleTrip[];
  /** 接驳车队总量（固定） */
  fleetTotal: number;
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  /** 客流上报：追加一条上报并立即重排未发车班次 */
  reportFlow: (stationId: string, stranded: number, risk: RiskLevel, reportedAt?: string) => void;
  /** 排车：携带调度台看到的版本号，版本不一致返回冲突 */
  scheduleTrip: (stationId: string, vehicles: number, expectedVersion: number) => ScheduleResult;
  /** 发车：已发车班次保留原占用 */
  departTrip: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
}

const now = () => new Date().toISOString();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now(), scheduleVersion: 0 },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now(), scheduleVersion: 0 },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now(), scheduleVersion: 0 }
];

const seedTrips: ShuttleTrip[] = [
  { id: "t1", stationId: "s1", vehicles: 6, state: "待发", disposition: "待定", risk: "高", stranded: 0, queuedAt: new Date(Date.now() - 20 * 60000).toISOString() },
  { id: "t2", stationId: "s2", vehicles: 4, state: "待发", disposition: "待定", risk: "中", stranded: 0, queuedAt: new Date(Date.now() - 12 * 60000).toISOString() }
];

const seedCapacity = recomputeCapacity({ trips: seedTrips, reports: [], stations: seedStations });

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  stations: seedStations,
  timeline: [
    { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
  ],
  reports: [],
  trips: seedCapacity.trips,
  fleetTotal: FLEET_TOTAL,
  role: "调度员",
  online: true,
  pendingActions: [],
  setRole: (role) => set({ role }),
  setOnline: (online) => set({ online }),
  setStationStatus: (id, status, note) => set((state) => {
    const stations = state.stations.map((station) =>
      station.id === id
        ? {
            ...station,
            status,
            note: note ?? station.note,
            updatedAt: now(),
            // 封闭/限流车站风险随状态上调，恢复后下调，未发车班次按新风险重排
            passengerRisk: (status === "封闭" ? "高" : status === "限流" ? "中" : status === "恢复中" ? "中" : "低") as RiskLevel
          }
        : station
    );
    const recomputed = recomputeCapacity({ trips: state.trips, reports: state.reports, stations });
    const target = state.stations.find((item) => item.id === id);
    return {
      stations,
      trips: recomputed.trips,
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${target?.name ?? id} → ${status}，未发车班次已重算`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" }, ...state.timeline],
      pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: "更新车站状态", detail: `${target?.name} → ${status}`, time: now() }, ...state.pendingActions]
    };
  }),
  addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions] })),
  addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
  submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline] })),
  approvePlan: (id, approver) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, approvals: Array.from(new Set([...plan.approvals, approver])), status: plan.approvals.length >= 1 ? "已确认" : plan.status } : plan) })),
  executePlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "已执行" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline] })),
  reportFlow: (stationId, stranded, risk, reportedAt) => set((state) => {
    const ts = now();
    const report: PassengerReport = {
      id: crypto.randomUUID(),
      stationId,
      stranded,
      risk,
      reportedAt: reportedAt ?? ts,
      arrivedAt: ts,
      reporter: state.role
    };
    const reports = [...state.reports, report];
    const recomputed = recomputeCapacity({ trips: state.trips, reports, stations: state.stations });
    const target = state.stations.find((item) => item.id === stationId);
    return {
      reports,
      trips: recomputed.trips,
      timeline: [{ id: crypto.randomUUID(), time: ts, actor: state.role, action: "客流上报", detail: `${target?.name ?? stationId} 上报滞留 ${stranded} 人（风险 ${risk}），未发车班次重新排队`, phase: "接驳" }, ...state.timeline]
    };
  }),
  scheduleTrip: (stationId, vehicles, expectedVersion) => {
    const result = scheduleTripPure({
      trips: get().trips,
      reports: get().reports,
      stations: get().stations,
      stationId,
      vehicles,
      expectedVersion,
      fleetTotal: get().fleetTotal
    });
    if (result.ok) {
      const target = get().stations.find((item) => item.id === stationId);
      const ts = now();
      set((state) => ({
        trips: result.trips,
        stations: result.stations as Station[],
        timeline: [{ id: crypto.randomUUID(), time: ts, actor: state.role, action: "排车", detail: `${target?.name ?? stationId} 班次 ${vehicles} 辆（排车版本 v${result.version}），占用车队容量`, phase: "接驳" }, ...state.timeline]
      }));
    }
    return result;
  },
  departTrip: (id) => set((state) => {
    const ts = now();
    const trips = departTripPure(state.trips, id, ts);
    const recomputed = recomputeCapacity({ trips, reports: state.reports, stations: state.stations });
    const trip = state.trips.find((item) => item.id === id);
    const target = state.stations.find((item) => item.id === trip?.stationId);
    return {
      trips: recomputed.trips,
      timeline: [{ id: crypto.randomUUID(), time: ts, actor: state.role, action: "班次发车", detail: `${target?.name ?? ""} 班次 ${trip?.vehicles ?? ""} 辆已发车，保留原占用`, phase: "接驳" }, ...state.timeline]
    };
  }),
  queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), action, detail, time: now() }, ...state.pendingActions] })),
  syncActions: () => set({ pendingActions: [] })
}), { name: "pair-wise-yf-47/incident" }));
