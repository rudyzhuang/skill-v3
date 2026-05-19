/** CLI → feishu-cursor-claw（bridge）出站事件的契约版本与载荷形状 */

export const BRIDGE_EVENTS_VERSION = "2026.05.feishu-bidir.v1" as const;

export type BridgeEventKind =
  | "stage_update"
  | "heartbeat"
  | "bridge_log_meta";

export interface BridgeEventBase {
  v: typeof BRIDGE_EVENTS_VERSION;
  kind: BridgeEventKind;
  correlation_id?: string;
  emitted_at: string;
}

export interface StageUpdatePayload {
  stage_name: string;
  previous_status: string | null;
  next_status: string;
  pipeline_current_stage: string | null;
  summary: string;
}

export interface StageUpdateEvent extends BridgeEventBase {
  kind: "stage_update";
  payload: StageUpdatePayload;
}

export interface HeartbeatEvent extends BridgeEventBase {
  kind: "heartbeat";
  payload: {
    note?: string;
    idle: boolean;
  };
}

export interface BridgeLogMetaEvent extends BridgeEventBase {
  kind: "bridge_log_meta";
  payload: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    /** 禁止写入密钥或 token 原文 */
    detail?: Record<string, string>;
  };
}

export type BridgeOutboundEvent =
  | StageUpdateEvent
  | HeartbeatEvent
  | BridgeLogMetaEvent;
