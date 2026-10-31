# 决策回放：投资决策复盘与学习

> 同花顺 AI 题第 2 题。在线地址、演示视频：（部署后补充）

投资者通常只记得盈亏，想不起当时知道什么、怎么想的。决策回放把交易记录、当时的理由、行情和事件对齐到一条时间线上，**分清"当时可知"和"事后才知"**，用程序算出的指标和带出处的 AI 解读，帮用户找出可以用在下一次决策上的教训。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 填入扶摇、DeepSeek、iFinD 的 Key
npm run dev                  # http://localhost:3000
```

需要 Node.js 24 及以上（用到内置的 `node:sqlite`）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `FUYAO_API_KEY` | 扶摇金融数据 API Key |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | DeepSeek，模型默认 `deepseek-flash` |
| `IFIND_MCP_URL` / `IFIND_MCP_AUTH` | iFinD MCP 综合服务的地址和 Authorization |
| `IFIND_QUOTA_LIMIT` | iFinD 调用上限（免费试用总共 2000 次），到了就只用扶摇 |
| `DATA_DIR` | SQLite 数据目录，默认 `./data` |

## 目标用户与产品选择

（待补）

## 核心设计

见 [docs/design.md](docs/design.md)：时点切分规则、行为偏差规则、AI 的角色和防后见之明措施、合规与降级。

## AI 的角色

（待补，详见 [docs/ai-usage.md](docs/ai-usage.md)）

## 数据来源

见 [docs/data-probe.md](docs/data-probe.md)。

## 已知边界与未做事项

（待补）

## 测试

（待补，详见 docs/testing.md）

---

本产品用于复盘学习，不构成任何投资建议。示例组合为构造的匿名数据，见 [demo/README.md](demo/README.md)。
