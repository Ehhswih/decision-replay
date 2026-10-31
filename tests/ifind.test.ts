import { describe, expect, it } from "vitest";
import { parseToolResult } from "@/lib/sources/ifind";

// 样例来自 2026-10-31 的实测返回（内容有删节）
const wrap = (inner: unknown) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }] } });

describe("iFinD 返回解析", () => {
  it("新闻：data 外面还包了一层 { data: '<json 字符串>' }", () => {
    const body = wrap({
      code: 1,
      msg: "success",
      data: { data: JSON.stringify([{ 资讯标题: "贵州茅台盈利预测", 资讯内容: "公司2026年中报实现营收922.78亿元", 日期: "2026-10-31", URL: "https://basic.10jqka.com.cn/600519/worth.html" }]) },
    });
    const r = parseToolResult(body);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.docs[0]).toMatchObject({ title: "贵州茅台盈利预测", date: "2026-10-31", aiGenerated: false });
  });

  it("公告：data 直接是 JSON 字符串；AI 生成的解读要标出来", () => {
    const body = wrap({
      code: 1,
      msg: "success",
      data: JSON.stringify([{ 公告标题: "贵州茅台2026年第一季度报告", 公告片段内容: "根据提供的材料，以下是对于贵州茅台2026年一季度的主要财务数据分析", 日期: "2026-04-25" }]),
    });
    const r = parseToolResult(body);
    expect(r.ok && r.docs[0].aiGenerated).toBe(true);
  });

  it("code 不为 1 算失败；额度相关的错误要识别出来", () => {
    expect(parseToolResult(wrap({ code: 0, msg: "参数错误" }))).toMatchObject({ ok: false, quota: false });
    expect(parseToolResult(wrap({ code: -1, msg: "调用次数已用完" }))).toMatchObject({ ok: false, quota: true });
    expect(parseToolResult({ jsonrpc: "2.0", id: 1, error: { message: "Unauthorized" } })).toMatchObject({ ok: false });
    expect(parseToolResult({ result: { content: [] } })).toMatchObject({ ok: false });
  });
});
