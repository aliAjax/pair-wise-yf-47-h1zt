"use client";

import { useMemo, useState } from "react";
import { Alert, App as AntApp, Button, Card, Col, Form, InputNumber, Row, Select, Space, Statistic, Switch, Table, Tag, message } from "antd";
import { format } from "date-fns";
import {
  FLEET_TOTAL,
  latestReports,
  type PassengerReport,
  type RiskLevel,
  type ShuttleTrip
} from "../lib/capacity";
import { useIncidentStore, type Station } from "../store/incident";

const riskColor: Record<RiskLevel, string> = { 高: "red", 中: "orange", 低: "green" };
type ConsoleKey = "A" | "B";

function CapacityPanel() {
  const state = useIncidentStore();
  const [reportForm] = Form.useForm();
  const [tripForm] = Form.useForm();
  const [messageApi, contextHolder] = message.useMessage();

  const [showAllReports, setShowAllReports] = useState(false);
  const [consoleVersions, setConsoleVersions] = useState<Record<ConsoleKey, Record<string, number>>>({ A: {}, B: {} });
  const [conflict, setConflict] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | undefined>(undefined);

  const stationName = (stationId: string) => state.stations.find((item) => item.id === stationId)?.name ?? stationId;

  const latestMap = useMemo(() => latestReports(state.reports), [state.reports]);

  const shownReports = useMemo(() => {
    const list = showAllReports ? state.reports : Array.from(latestMap.values());
    return [...list].sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  }, [state.reports, latestMap, showAllReports]);

  const waitingOrder = useMemo(() => state.trips.filter((trip) => trip.state === "待发"), [state.trips]);

  const occupiedVehicles = state.trips.filter((trip) => trip.disposition === "占用").reduce((sum, trip) => sum + trip.vehicles, 0);
  const pendingVehicles = state.trips.filter((trip) => trip.disposition === "待定").reduce((sum, trip) => sum + trip.vehicles, 0);

  const versionOf = (consoleKey: ConsoleKey, stationId: string) =>
    consoleVersions[consoleKey][stationId] ?? state.stations.find((item) => item.id === stationId)?.scheduleVersion ?? 0;

  const refreshVersion = (consoleKey: ConsoleKey, stationId: string) => {
    const current = state.stations.find((item) => item.id === stationId)?.scheduleVersion ?? 0;
    setConsoleVersions((prev) => ({ ...prev, [consoleKey]: { ...prev[consoleKey], [stationId]: current } }));
  };

  const submitReport = (values: { stationId: string; stranded: number; risk: RiskLevel; late?: boolean }) => {
    // 迟到上报：上报时间记为 20 分钟前（到达时间为当下），到达后相关班次立即重排
    const reportedAt = values.late ? new Date(Date.now() - 20 * 60000).toISOString() : undefined;
    state.reportFlow(values.stationId, values.stranded, values.risk, reportedAt);
    messageApi.success("客流已上报，未发车班次按风险与滞留人数重新排队");
    reportForm.resetFields();
  };

  const submitSchedule = (consoleKey: ConsoleKey) => {
    const values = tripForm.getFieldsValue() as { stationId?: string; vehicles?: number };
    if (!values.stationId || !values.vehicles) {
      messageApi.warning("请选择车站并填写车辆数");
      return;
    }
    const stationId = values.stationId;
    const expected = versionOf(consoleKey, stationId);
    const result = state.scheduleTrip(stationId, values.vehicles, expected);
    if (!result.ok) {
      setConflict(
        `调度台 ${consoleKey} 提交失败：${stationName(stationId)} 的排车已被另一调度台先提交（排车版本 v${expected} → v${result.currentVersion}）。请读取最新版本后重新提交。`
      );
      messageApi.error("排车冲突：另一调度台已先提交");
      return;
    }
    setConflict(null);
    setConsoleVersions((prev) => ({ ...prev, [consoleKey]: { ...prev[consoleKey], [stationId]: result.version } }));
    messageApi.success(`调度台 ${consoleKey} 排车成功：${stationName(stationId)} ${values.vehicles} 辆（v${result.version}）`);
  };

  const canSchedule = state.role === "调度员" || state.role === "公交接驳负责人";
  const canReport = state.role !== "客服主管";

  const reportColumns = [
    { title: "车站", dataIndex: "stationId", render: (id: string) => stationName(id) },
    { title: "风险等级", dataIndex: "risk", render: (risk: RiskLevel) => <Tag color={riskColor[risk]}>{risk}风险</Tag> },
    { title: "滞留人数", dataIndex: "stranded", render: (value: number) => <b>{value}</b> },
    { title: "上报时间", dataIndex: "reportedAt", render: (value: string) => format(new Date(value), "MM-dd HH:mm:ss") },
    { title: "到达时间", dataIndex: "arrivedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "上报人", dataIndex: "reporter" },
    {
      title: "归集状态",
      render: (_: unknown, record: PassengerReport) =>
        latestMap.get(record.stationId)?.id === record.id ? <Tag color="green">有效</Tag> : <Tag>被覆盖</Tag>
    }
  ];

  const tripColumns = [
    {
      title: "排队顺位",
      render: (_: unknown, record: ShuttleTrip) =>
        record.state === "已发车" ? <Tag color="blue">已发车</Tag> : <Tag>{waitingOrder.findIndex((item) => item.id === record.id) + 1}</Tag>
    },
    { title: "车站", dataIndex: "stationId", render: (id: string) => stationName(id) },
    { title: "车辆", dataIndex: "vehicles", render: (value: number) => `${value} 辆` },
    { title: "风险", dataIndex: "risk", render: (risk: RiskLevel) => <Tag color={riskColor[risk]}>{risk}</Tag> },
    { title: "滞留人数", dataIndex: "stranded" },
    {
      title: "班次状态",
      dataIndex: "state",
      render: (value: string) => <Tag color={value === "已发车" ? "blue" : "orange"}>{value}</Tag>
    },
    {
      title: "运力状态",
      dataIndex: "disposition",
      render: (value: string) => <Tag color={value === "占用" ? "green" : "red"}>{value === "占用" ? "占用运力" : "排队待定"}</Tag>
    },
    {
      title: "操作",
      render: (_: unknown, record: ShuttleTrip) => (
        <Button size="small" type="primary" ghost disabled={record.state === "已发车" || state.role === "客服主管"} onClick={() => state.departTrip(record.id)}>
          发车
        </Button>
      )
    }
  ];

  return (
    <div className="capacity-panel">
      {contextHolder}
      <Alert
        className="capacity-rule"
        type="info"
        showIcon
        message="运力账规则"
        description={`接驳车队总量固定 ${state.fleetTotal} 辆：未发车班次按风险等级（高→中→低）再按滞留人数排队占用运力，超出部分排队待定；同一车站重复上报只认更晚一条，迟到上报到达后相关班次立即重排；已发车班次保留原占用；两个调度台同时提交同一车站排车时，版本一致才放行，后提交一方见冲突。`}
      />
      <Row gutter={16}>
        <Col span={6}><Card><Statistic title="车队总运力" value={state.fleetTotal} suffix="辆" /></Card></Col>
        <Col span={6}><Card><Statistic title="已占用" value={occupiedVehicles} suffix="辆" valueStyle={{ color: "#1677ff" }} /></Card></Col>
        <Col span={6}><Card><Statistic title="排队待定" value={pendingVehicles} suffix="辆" valueStyle={{ color: "#cf1322" }} /></Card></Col>
        <Col span={6}><Card><Statistic title="剩余可用" value={state.fleetTotal - occupiedVehicles} suffix="辆" valueStyle={{ color: "#389e0d" }} /></Card></Col>
      </Row>

      <Row gutter={16}>
        <Col span={11}>
          <Card
            title="客流上报"
            className="capacity-card"
            extra={<Space><span style={{ color: "#68758c", fontSize: 12 }}>显示历史上报</span><Switch size="small" checked={showAllReports} onChange={setShowAllReports} /></Space>}
          >
            <Form form={reportForm} layout="vertical" onFinish={submitReport} initialValues={{ risk: "高", late: false }}>
              <Form.Item name="stationId" label="车站" rules={[{ required: true, message: "请选择车站" }]}>
                <Select options={state.stations.map((station: Station) => ({ value: station.id, label: station.name }))} placeholder="选择上报车站" />
              </Form.Item>
              <Space align="baseline" wrap>
                <Form.Item name="stranded" label="滞留人数" rules={[{ required: true, message: "请填写人数" }]}>
                  <InputNumber min={1} max={9999} addonAfter="人" style={{ width: 130 }} />
                </Form.Item>
                <Form.Item name="risk" label="风险等级">
                  <Select style={{ width: 110 }} options={(Object.keys(riskColor) as RiskLevel[]).map((risk) => ({ value: risk, label: `${risk}风险` }))} />
                </Form.Item>
                <Form.Item name="late" label="迟到上报" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Space>
              <Button type="primary" htmlType="submit" disabled={!canReport}>上报客流</Button>
            </Form>
            <Table
              className="capacity-table"
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={shownReports}
              columns={reportColumns}
              locale={{ emptyText: "暂无客流上报" }}
            />
          </Card>
        </Col>

        <Col span={13}>
          <Card title="班次排车（双调度台并发）" className="capacity-card">
            <Form form={tripForm} layout="vertical" initialValues={{ vehicles: 6 }}>
              <Form.Item name="stationId" label="排车车站" rules={[{ required: true, message: "请选择车站" }]}>
                <Select
                  options={state.stations.map((station: Station) => ({ value: station.id, label: `${station.name}（当前版本 v${station.scheduleVersion}）` }))}
                  placeholder="选择排车车站"
                  onChange={(stationId: string) => { setSelectedStationId(stationId); refreshVersion("A", stationId); refreshVersion("B", stationId); setConflict(null); }}
                />
              </Form.Item>
              <Form.Item name="vehicles" label="车辆数" rules={[{ required: true, message: "请填写车辆数" }]}>
                <InputNumber min={1} max={FLEET_TOTAL} addonAfter="辆" style={{ width: 150 }} />
              </Form.Item>
              <Space wrap>
                <Button
                  type="primary"
                  disabled={!canSchedule}
                  onClick={() => submitSchedule("A")}
                >调度台 A 提交排车（v{selectedStationId ? versionOf("A", selectedStationId) : 0}）</Button>
                <Button
                  type="primary"
                  danger
                  disabled={!canSchedule}
                  onClick={() => submitSchedule("B")}
                >调度台 B 提交排车（v{selectedStationId ? versionOf("B", selectedStationId) : 0}）</Button>
                <Button onClick={() => {
                  if (selectedStationId) { refreshVersion("A", selectedStationId); refreshVersion("B", selectedStationId); messageApi.info("已读取最新排车版本"); }
                }}>读取最新版本</Button>
              </Space>
            </Form>
            {conflict && <Alert className="capacity-conflict" type="error" showIcon message="排车冲突" description={conflict} />}
          </Card>
        </Col>
      </Row>

      <Card title="班次台账（运力账）" className="capacity-card">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={state.trips}
          columns={tripColumns}
          locale={{ emptyText: "暂无班次" }}
        />
      </Card>
    </div>
  );
}

export default function CapacityPanelWithAnt() {
  return <AntApp><CapacityPanel /></AntApp>;
}
