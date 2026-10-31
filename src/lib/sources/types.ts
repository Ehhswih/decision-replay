export type SourceName = "fuyao" | "ifind";

/**
 * ok：成功且有数据；empty：成功但没有数据（不等于"没有发生"，见各接口说明）；
 * stale：这次调用失败，用的是之前缓存的数据；failed：失败且没有可用数据
 */
export type FetchStatus = "ok" | "empty" | "stale" | "failed";

export type ErrorKind =
  | "auth"
  | "permission"
  | "bad_param"
  | "not_found"
  | "not_ready"
  | "unsupported"
  | "rate_limit"
  | "upstream"
  | "timeout"
  | "network"
  | "quota"
  | "parse"
  | "config";

export interface SourceError {
  kind: ErrorKind;
  code?: string | number;
  message: string;
}

export interface SourceMeta {
  source: SourceName;
  endpoint: string;
  params: Record<string, unknown>;
  fetchedAt: number;
  fromCache: boolean;
  latencyMs: number | null;
  attempts: number;
}

export interface SourceResult<T> {
  status: FetchStatus;
  data: T | null;
  error?: SourceError;
  meta: SourceMeta;
}

export const ERROR_LABEL: Record<ErrorKind, string> = {
  auth: "API Key 无效或缺失",
  permission: "API Key 没有这个接口的权限",
  bad_param: "请求参数有误",
  not_found: "标的不存在",
  not_ready: "数据未就绪",
  unsupported: "该标的不支持这个数据",
  rate_limit: "触发限流",
  upstream: "数据源服务异常",
  timeout: "请求超时",
  network: "网络错误",
  quota: "调用额度已用完",
  parse: "返回内容无法解析",
  config: "服务端未配置该数据源",
};

export const STATUS_LABEL: Record<FetchStatus, string> = {
  ok: "正常",
  empty: "未获取到数据",
  stale: "使用缓存（本次获取失败）",
  failed: "获取失败",
};
