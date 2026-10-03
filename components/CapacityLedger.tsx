"use client";

import { useMemo, useState } from "react";
import { App as AntApp, Alert, Badge, Button, Card, Checkbox, Col, InputNumber, Row, Select, Space, Statistic, Table, Tag } from "antd";
import { format } from "date-fns";
import type { ColumnsType } from "antd/es/table";
import { effectiveReports, riskWeight, useIncidentStore, type PassengerReport, type RiskLevel, type ShuttleTrip } from "../store/incident";

const riskColor: Record<RiskLevel, string> = { 高: "red", 中: "orange", 低: "green" };
const tripStatusColor: Record<ShuttleTrip["status"], string> = { 待发: "blue", 待定: "orange", 已发车: "green", 已取消: "default" };

function DeskCard({ deskId }: { deskId: string }) {
  const { message } = AntApp.useApp();
  const stations = useIncidentStore((state) => state.stations);
  const stationLedger = useIncidentStore((state) => state.stationLedger);
  const submitTrip = useIncidentStore((state) => state.submitTrip);
  const role = useIncidentStore((state) => state.role);
  const [stationId, setStationId] = useState(stations[0]?.id ?? "");
  const [vehicles, setVehicles] = useState(4);
  // 提交 时以本地快照版本做乐观校验；另一调度台放行后此快照即过期
  const [baseVersion, setBaseVersion] = useState(() => stationLedger[stations[0]?.id ?? ""] ?? 0);
  const [conflict, setConflict] = useState<string | null>(null);

  const liveVersion = stationLedger[stationId] ?? 0;
  const stale = liveVersion !== baseVersion;

  const pickStation = (id: string) => {
    setStationId(id);
    setBaseVersion(stationLedger[id] ?? 0);
    setConflict(null);
  };

  const submit = () => {
    const result = submitTrip(stationId, vehicles, deskId, baseVersion);
    if (result.ok) {
      setBaseVersion(result.currentVersion);
      setConflict(null);
      message.success(`${deskId} 排车已放行，进入运力账排队`);
    } else {
      setConflict(`提交被拒：你基于 v${baseVersion} 排车，该车站版本已变为 v${result.currentVersion}，另一调度台的排车已放行。请刷新版本后重新提交。`);
    }
  };

  return <Card size="small" title={deskId} extra={<Tag color={stale ? "red" : "blue"}>基于版本 v{baseVersion}{stale ? ` / 当前 v${liveVersion}` : ""}</Tag>}>
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space wrap>
        <Select style={{ width: 150 }} value={stationId} onChange={pickStation} options={stations.map((station) => ({ value: station.id, label: station.name }))} />
        <InputNumber min={1} max={20} value={vehicles} onChange={(value) => setVehicles(value ?? 1)} addonAfter="辆" />
        <Button type="primary" disabled={role !== "调度员"} onClick={submit}>提交排车</Button>
        <Button disabled={!stale && !conflict} onClick={() => { setBaseVersion(liveVersion); setConflict(null); }}>刷新版本</Button>
      </Space>
      {role !== "调度员" && <small style={{ color: "#8b95a6" }}>仅调度员角色可提交排车</small>}
      {conflict && <Alert type="error" showIcon message="排车冲突" description={conflict} />}
    </Space>
  </Card>;
}

export function CapacityLedger() {
  const { message } = AntApp.useApp();
  const state = useIncidentStore();
  const [reportStation, setReportStation] = useState(state.stations[0]?.id ?? "");
  const [stranded, setStranded] = useState(800);
  const [risk, setRisk] = useState<RiskLevel>("中");
  const [late, setLate] = useState(false);

  const effective = useMemo(() => effectiveReports(state.reports), [state.reports]);
  const stationName = (id: string) => state.stations.find((station) => station.id === id)?.name ?? id;
  const riskOf = (id: string): RiskLevel => effective.get(id)?.risk ?? state.stations.find((station) => station.id === id)?.passengerRisk ?? "低";

  const departedUsed = state.trips.filter((trip) => trip.status === "已发车").reduce((sum, trip) => sum + trip.allocated, 0);
  const readyUsed = state.trips.filter((trip) => trip.status === "待发").reduce((sum, trip) => sum + trip.allocated, 0);
  const pendingDemand = state.trips.filter((trip) => trip.status === "待定").reduce((sum, trip) => sum + trip.vehicles, 0);
  const remaining = state.fleetTotal - departedUsed - readyUsed;

  const reportColumns: ColumnsType<PassengerReport> = [
    { title: "车站", dataIndex: "stationId", render: stationName },
    { title: "滞留人数", dataIndex: "stranded", render: (value: number) => `${value} 人` },
    { title: "风险", dataIndex: "risk", render: (value: RiskLevel) => <Tag color={riskColor[value]}>{value}</Tag> },
    { title: "上报时间", dataIndex: "reportedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "接收时间", dataIndex: "receivedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "效力", render: (_, record) => effective.get(record.stationId)?.id === record.id ? <Badge status="success" text="有效" /> : <Badge status="default" text="被更晚上报覆盖" /> }
  ];

  const tripColumns: ColumnsType<ShuttleTrip> = [
    { title: "班次", dataIndex: "id", render: (value: string) => value.slice(0, 6) },
    { title: "车站", dataIndex: "stationId", render: stationName },
    { title: "风险等级", dataIndex: "stationId", render: (id: string) => <Tag color={riskColor[riskOf(id)]}>{riskOf(id)}</Tag>, sorter: (a, b) => riskWeight[riskOf(a.stationId)] - riskWeight[riskOf(b.stationId)] },
    { title: "滞留人数", dataIndex: "stationId", render: (id: string) => effective.get(id)?.stranded ?? 0, sorter: (a, b) => (effective.get(a.stationId)?.stranded ?? 0) - (effective.get(b.stationId)?.stranded ?? 0) },
    { title: "需求车辆", dataIndex: "vehicles" },
    { title: "占用", dataIndex: "allocated", render: (value: number, record) => record.status === "已发车" ? <b>{value}（冻结）</b> : value },
    { title: "状态", dataIndex: "status", render: (value: ShuttleTrip["status"]) => <Tag color={tripStatusColor[value]}>{value}</Tag> },
    { title: "排队位次", dataIndex: "queueIndex", render: (value?: number) => value ?? "—" },
    { title: "调度台", dataIndex: "desk" },
    { title: "提交时间", dataIndex: "submittedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "操作", render: (_, record) => <Space>
      <Button size="small" type="primary" disabled={record.status !== "待发"} onClick={() => { state.departTrip(record.id); message.success("班次已发车，占用冻结"); }}>发车</Button>
      <Button size="small" danger disabled={record.status === "已发车" || record.status === "已取消"} onClick={() => state.cancelTrip(record.id)}>取消</Button>
    </Space> }
  ];

  const submitReport = () => {
    if (!reportStation || stranded <= 0) return;
    state.submitReport(reportStation, stranded, risk, late ? 12 : 0);
    message.success(late ? "迟到上报已接收，相关班次已重排" : "客流上报已接收，未发车班次已重排");
  };

  return <Space direction="vertical" size={16} style={{ width: "100%" }}>
    <Alert type="info" showIcon message="运力账规则" description="车队总量固定；未发车班次按 风险等级 → 滞留人数 → 提交时间 排队占用车队容量，容量不足起整队待定；已发车班次保留原占用；车站状态变化或新上报到达立即重算；同一车站重复上报只认更晚的一条。" />
    <section className="metrics ledger-metrics">
      <Card><Statistic title="车队总量" value={state.fleetTotal} suffix="辆" /></Card>
      <Card><Statistic title="已发车占用" value={departedUsed} suffix="辆" /></Card>
      <Card><Statistic title="待发占用" value={readyUsed} suffix="辆" /></Card>
      <Card><Statistic title="剩余可用" value={remaining} suffix="辆" valueStyle={{ color: remaining > 0 ? "#18a566" : "#e5484d" }} /></Card>
      <Card><Statistic title="待定需求" value={pendingDemand} suffix="辆" valueStyle={{ color: pendingDemand > 0 ? "#f39c12" : undefined }} /></Card>
    </section>
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <Card title="客流上报" extra={<Space>
          <Select style={{ width: 130 }} value={reportStation} onChange={(value) => { setReportStation(value); const station = state.stations.find((item) => item.id === value); if (station) setRisk(station.passengerRisk); }} options={state.stations.map((station) => ({ value: station.id, label: station.name }))} />
          <InputNumber min={1} value={stranded} onChange={(value) => setStranded(value ?? 1)} addonAfter="人" />
          <Select style={{ width: 90 }} value={risk} onChange={setRisk} options={(["高", "中", "低"] as RiskLevel[]).map((value) => ({ value, label: `${value}风险` }))} />
          <Checkbox checked={late} onChange={(event) => setLate(event.target.checked)}>迟到补报</Checkbox>
          <Button type="primary" disabled={state.role === "客服主管"} onClick={submitReport}>上报</Button>
        </Space>}>
          <Table rowKey="id" size="small" pagination={false} scroll={{ x: 640 }} dataSource={[...state.reports].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))} columns={reportColumns} />
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card title="调度台排车（同一车站同时提交只放行一方）">
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <DeskCard deskId="调度台A" />
            <DeskCard deskId="调度台B" />
          </Space>
        </Card>
      </Col>
    </Row>
    <Card title="班次运力账">
      <Table rowKey="id" size="small" pagination={false} scroll={{ x: 900 }} dataSource={state.trips} columns={tripColumns} />
    </Card>
  </Space>;
}
