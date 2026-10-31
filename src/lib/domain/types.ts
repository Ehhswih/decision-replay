export type Side = "buy" | "sell";

/** 导入后的一笔成交 */
export interface Trade {
  id: string;
  rowNo: number;
  ts: number;
  timeKnown: boolean;
  code: string;
  name: string | null;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  reason: string | null;
  /** 计划止损幅度，正数，单位 % */
  planStop: number | null;
  /** 计划目标涨幅，正数，单位 % */
  planTarget: number | null;
}

/** info：不影响复盘的说明，例如跳过了转账、分红等非买卖记录 */
export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  rowNo?: number;
  tradeId?: string;
  field?: string;
}

/** 不复权日 K */
export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

/** 除权除息事件（扶摇只给除权日、每股分红、每股送转） */
export interface CorpAction {
  exDate: string;
  cashPerShare: number;
  bonusPerShare: number;
}

export interface EpisodeCorpEvent extends CorpAction {
  sharesBefore: number;
  bonusShares: number;
  cashReceived: number;
}

export interface EpisodeTrade extends Trade {
  positionAfter: number;
}

/** 持仓段：一只股票从空仓到有仓再回到空仓 */
export interface Episode {
  id: string;
  code: string;
  name: string | null;
  openTs: number;
  closeTs: number | null;
  trades: EpisodeTrade[];
  corpEvents: EpisodeCorpEvent[];
  buyCost: number;
  sellProceeds: number;
  dividends: number;
  fees: number;
  realizedPnl: number | null;
  returnPct: number | null;
  maxPosition: number;
}
