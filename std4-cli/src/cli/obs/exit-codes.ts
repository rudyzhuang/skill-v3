/**
 * CLI 退出码约定（单一真源；验收可对照本表或 docs/cli-exit-codes.md）。
 *
 * | 场景 | 码 | 说明 |
 * |------|----|------|
 * | 成功 | 0 | 正常完成 |
 * | 内部/未捕获 | 1 | 未预期异常（兜底） |
 * | 用法错误（未知选项等） | 2 | Commander 无法解析 |
 * | 配置 / 必填环境缺失或解析失败 | 3 | 含缺失配置文件 |
 * | Dash / 外部 HTTP 4xx | 4 | 客户端类错误 |
 * | Dash / 外部 HTTP 5xx | 5 | 服务端类错误 |
 * | 子进程非零退出 | 6 | 汇聚子进程状态 |
 * | 非交互校验失败（缺必填参数） | 7 | create --non-interactive |
 */
export const EXIT_SUCCESS = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 3;
export const EXIT_DASH_HTTP_4XX = 4;
export const EXIT_DASH_HTTP_5XX = 5;
export const EXIT_SUBPROCESS = 6;
export const EXIT_VALIDATION = 7;

export function exitCodeForHttpStatus(status: number): number {
  if (status >= 500) return EXIT_DASH_HTTP_5XX;
  if (status >= 400) return EXIT_DASH_HTTP_4XX;
  return EXIT_SUCCESS;
}
