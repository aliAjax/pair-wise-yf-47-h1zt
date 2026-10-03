// 运力账核心逻辑：
// 1. 客流上报按车站归集，重复上报只认更晚的一条（LWW）；
// 2. 未发车班次按风险等级、滞留人数排队，占用固定车队容量，超出部分排队待定；
// 3. 已发车班次锁定原占用，迟到上报/车站状态变化只重排未发车班次；
// 4. 同一车站排车携带版本号，两个调度台同时提交只放行一方，另一方见冲突。
// 纯函数、无 React 依赖，可独立测试。

export type RiskLevel = "高" | "中" | "低";
export type TripState = "待发" | "已发车";
export type Disposition = "占用" | "待定";

/** 接驳车队总量（固定） */
export const FLEET_TOTAL = 20;

export const RISK_WEIGHT: Record<RiskLevel, number> = { 高: 3, 中: 2, 低: 1 };

/** 客流上报（车站报来的滞留客流） */
export interface PassengerReport {
  id: string;
  stationId: string;
  stranded: number; // 滞留人数
  risk: RiskLevel; // 风险等级
  reportedAt: string; // 上报时间（车站填报）
  arrivedAt: string; // 到达协同台时间（迟到上报可能晚到）
  reporter: string;
}

/** 接驳班次（运力账的占用单位） */
export interface ShuttleTrip {
  id: string;
  stationId: string;
  vehicles: number; // 占用车辆数
  state: TripState; // 待发 | 已发车
  disposition: Disposition; // 占用 | 待定（重算后写入）
  risk: RiskLevel; // 排队用风险（重算时取最新上报）
  stranded: number; // 排队用滞留人数
  queuedAt: string; // 进入队列时间
  departedAt?: string;
}

export interface StationLike {
  id: string;
  name?: string;
  status?: string;
  passengerRisk?: RiskLevel;
  /** 排车版本号：每次成功排车 +1，用于乐观并发控制 */
  scheduleVersion?: number;
}

export interface QueueRow {
  tripId: string;
  stationId: string;
  vehicles: number;
  risk: RiskLevel;
  stranded: number;
  state: TripState;
  disposition: Disposition;
  /** 排队顺位（已发车为 0，不参与排队） */
  position: number;
}

export interface CapacityResult {
  /** 重算后的班次（已发车在前锁定，未发车按队列顺序排列） */
  trips: ShuttleTrip[];
  /** 已占用运力（已发车 + 占用中的未发车班次） */
  occupied: number;
  /** 排队待定的车辆数 */
  pendingVehicles: number;
  /** 剩余可用运力 */
  available: number;
  queue: QueueRow[];
}

export function riskFromStation(station: StationLike | undefined): RiskLevel {
  if (!station) return "低";
  if (station.passengerRisk) return station.passengerRisk;
  if (station.status === "封闭") return "高";
  if (station.status === "限流") return "中";
  return "低";
}

/**
 * 同一车站重复上报只认更晚的一条：
 * reportedAt 晚者胜；reportedAt 相同则 arrivedAt 晚者胜。
 */
export function latestReports(reports: PassengerReport[]): Map<string, PassengerReport> {
  const map = new Map<string, PassengerReport>();
  for (const report of reports) {
    const prev = map.get(report.stationId);
    if (!prev) {
      map.set(report.stationId, report);
      continue;
    }
    const delta = Date.parse(report.reportedAt) - Date.parse(prev.reportedAt);
    if (delta > 0 || (delta === 0 && Date.parse(report.arrivedAt) >= Date.parse(prev.arrivedAt))) {
      map.set(report.stationId, report);
    }
  }
  return map;
}

/** 队列排序：风险等级高在前，滞留人数多在前，先到者在前 */
export function compareTrips(a: ShuttleTrip, b: ShuttleTrip): number {
  const riskDelta = RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk];
  if (riskDelta !== 0) return riskDelta;
  if (b.stranded !== a.stranded) return b.stranded - a.stranded;
  return Date.parse(a.queuedAt) - Date.parse(b.queuedAt);
}

/**
 * 重算运力账：
 * - 已发车班次锁定原占用，不再参与排队；
 * - 未发车班次按风险等级、滞留人数重新排队，依次占用剩余运力，超出部分排队待定；
 * - 迟到上报到达后，班次的风险/滞留人数取最新上报值，因此相关班次（全局队列）重排。
 */
export function recomputeCapacity(input: {
  trips: ShuttleTrip[];
  reports: PassengerReport[];
  stations: StationLike[];
  fleetTotal?: number;
}): CapacityResult {
  const fleetTotal = input.fleetTotal ?? FLEET_TOTAL;
  const latest = latestReports(input.reports);
  const stationOf = new Map(input.stations.map((station) => [station.id, station]));

  const enriched: ShuttleTrip[] = input.trips.map((trip) => {
    if (trip.state === "已发车") return { ...trip, disposition: "占用" };
    const report = latest.get(trip.stationId);
    // 风险：最新上报优先，否则取车站当前状态（封闭/限流会上调风险）；
    // 滞留人数：最新上报优先，否则保留班次快照。
    const risk = report?.risk ?? riskFromStation(stationOf.get(trip.stationId));
    const stranded = report?.stranded ?? trip.stranded ?? 0;
    return { ...trip, risk, stranded, disposition: "待定" };
  });

  const departed = enriched.filter((trip) => trip.state === "已发车");
  const waiting = enriched.filter((trip) => trip.state === "待发").sort(compareTrips);

  let occupied = departed.reduce((sum, trip) => sum + trip.vehicles, 0);
  let pendingVehicles = 0;
  const queue: QueueRow[] = [];
  const ledger: ShuttleTrip[] = [];

  departed.forEach((trip) => {
    ledger.push(trip);
    queue.push({
      tripId: trip.id,
      stationId: trip.stationId,
      vehicles: trip.vehicles,
      risk: trip.risk,
      stranded: trip.stranded,
      state: trip.state,
      disposition: "占用",
      position: 0
    });
  });

  let position = 0;
  for (const trip of waiting) {
    position += 1;
    const fits = occupied + trip.vehicles <= fleetTotal;
    const disposition: Disposition = fits ? "占用" : "待定";
    if (fits) occupied += trip.vehicles;
    else pendingVehicles += trip.vehicles;
    const row = { ...trip, disposition };
    ledger.push(row);
    queue.push({
      tripId: row.id,
      stationId: row.stationId,
      vehicles: row.vehicles,
      risk: row.risk,
      stranded: row.stranded,
      state: row.state,
      disposition,
      position
    });
  }

  return { trips: ledger, occupied, pendingVehicles, available: fleetTotal - occupied, queue };
}

export interface ScheduleInput {
  trips: ShuttleTrip[];
  reports: PassengerReport[];
  stations: StationLike[];
  stationId: string;
  vehicles: number;
  /** 调度台提交时看到的排车版本号 */
  expectedVersion: number;
  fleetTotal?: number;
  now?: string;
  id?: () => string;
}

export type ScheduleResult =
  | {
      ok: true;
      trips: ShuttleTrip[];
      stations: StationLike[];
      trip: ShuttleTrip;
      version: number;
      occupied: number;
      pendingVehicles: number;
      available: number;
    }
  | { ok: false; reason: "conflict"; currentVersion: number };

/**
 * 排车（创建未发车班次）。乐观并发：
 * 调度台提交的 expectedVersion 与车站当前 scheduleVersion 一致才放行，
 * 版本不一致说明另一调度台已先提交，本次拒绝并返回当前版本（冲突）。
 */
export function scheduleTrip(input: ScheduleInput): ScheduleResult {
  const station = input.stations.find((item) => item.id === input.stationId);
  const currentVersion = station?.scheduleVersion ?? 0;
  if (currentVersion !== input.expectedVersion) {
    return { ok: false, reason: "conflict", currentVersion };
  }

  const now = input.now ?? new Date().toISOString();
  const genId =
    input.id ??
    (() =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const latest = latestReports(input.reports);
  const report = latest.get(input.stationId);
  const trip: ShuttleTrip = {
    id: genId(),
    stationId: input.stationId,
    vehicles: input.vehicles,
    state: "待发",
    disposition: "待定",
    risk: report?.risk ?? riskFromStation(station),
    stranded: report?.stranded ?? 0,
    queuedAt: now
  };

  const nextStations = input.stations.map((item) =>
    item.id === input.stationId ? { ...item, scheduleVersion: currentVersion + 1 } : item
  );
  const recomputed = recomputeCapacity({
    trips: [...input.trips, trip],
    reports: input.reports,
    stations: nextStations,
    fleetTotal: input.fleetTotal
  });
  const created = recomputed.trips.find((item) => item.id === trip.id) ?? trip;

  return {
    ok: true,
    trips: recomputed.trips,
    stations: nextStations,
    trip: created,
    version: currentVersion + 1,
    occupied: recomputed.occupied,
    pendingVehicles: recomputed.pendingVehicles,
    available: recomputed.available
  };
}

/** 发车：班次标记为已发车，保留原占用，不再参与排队 */
export function departTrip(trips: ShuttleTrip[], id: string, now?: string): ShuttleTrip[] {
  const departedAt = now ?? new Date().toISOString();
  return trips.map((trip) => (trip.id === id ? { ...trip, state: "已发车" as TripState, departedAt } : trip));
}
