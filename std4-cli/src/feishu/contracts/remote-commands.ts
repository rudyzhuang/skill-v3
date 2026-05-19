/** bridge → CLI 遥控指令规范化类型 */

export const REMOTE_COMMANDS_VERSION = "2026.05.feishu-bidir.v1" as const;

export type RemoteCommandName = "status" | "stop" | "mode" | "unknown";

export interface RemoteCommandEnvelope {
  v: typeof REMOTE_COMMANDS_VERSION;
  command: RemoteCommandName;
  args: string[];
  raw_text: string;
  correlation_id: string;
}
