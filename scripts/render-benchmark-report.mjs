import fs from 'node:fs';
import process from 'node:process';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('用法：node render-benchmark-report.mjs <results.json> <report.html>');

const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const safeJson = JSON.stringify(payload).replaceAll('<', '\\u003c');
const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });

const html = `<div id="mcpDbBenchmarkReport">
  <style>
    #mcpDbBenchmarkReport {
      --bench-ink: #172033;
      --bench-muted: #667085;
      --bench-line: #e7eaf0;
      --bench-soft: #f7f8fb;
      --bench-mcp: #5b5bd6;
      --bench-db: #0f9f8f;
      --bench-warn: #b7791f;
      --bench-bad: #c53d4b;
      color: var(--bench-ink);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
      max-width: 1024px;
      margin: 0 auto;
    }
    #mcpDbBenchmarkReport * { box-sizing: border-box; }
    #mcpDbBenchmarkReport .bench-hero { padding: 4px 0 18px; }
    #mcpDbBenchmarkReport h1 { margin: 0; font-size: 25px; line-height: 1.25; letter-spacing: -0.02em; }
    #mcpDbBenchmarkReport h2 { margin: 0; font-size: 16px; line-height: 1.35; }
    #mcpDbBenchmarkReport h3 { margin: 0 0 7px; font-size: 13px; }
    #mcpDbBenchmarkReport p { margin: 5px 0; color: var(--bench-muted); font-size: 12px; }
    #mcpDbBenchmarkReport .bench-eyebrow { margin: 0 0 6px; color: var(--bench-mcp); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    #mcpDbBenchmarkReport .bench-subtitle { max-width: 760px; font-size: 13px; }
    #mcpDbBenchmarkReport .bench-generated { margin-top: 9px; font-size: 11px; color: #98a2b3; }
    #mcpDbBenchmarkReport .bench-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 9px; margin: 0 0 18px; }
    #mcpDbBenchmarkReport .bench-metric { padding: 12px 13px; border: 1px solid var(--bench-line); border-radius: 10px; background: #fff; }
    #mcpDbBenchmarkReport .bench-metric-label { color: var(--bench-muted); font-size: 11px; }
    #mcpDbBenchmarkReport .bench-metric-value { margin-top: 2px; font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 700; }
    #mcpDbBenchmarkReport .bench-metric-note { color: #98a2b3; font-size: 10px; }
    #mcpDbBenchmarkReport .bench-section { margin-top: 16px; padding: 17px; border: 1px solid var(--bench-line); border-radius: 12px; background: #fff; }
    #mcpDbBenchmarkReport .bench-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
    #mcpDbBenchmarkReport .bench-legend { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    #mcpDbBenchmarkReport .bench-legend button { border: 0; padding: 2px 0; color: var(--bench-ink); background: transparent; cursor: pointer; font: inherit; font-size: 11px; }
    #mcpDbBenchmarkReport .bench-legend button[aria-pressed="false"] { opacity: .38; text-decoration: line-through; }
    #mcpDbBenchmarkReport .bench-swatch { display: inline-block; width: 9px; height: 9px; margin-right: 4px; border-radius: 50%; vertical-align: 0; }
    #mcpDbBenchmarkReport .bench-swatch-mcp { background: var(--bench-mcp); }
    #mcpDbBenchmarkReport .bench-swatch-db { background: var(--bench-db); }
    #mcpDbBenchmarkReport .bench-chart { display: grid; gap: 9px; }
    #mcpDbBenchmarkReport .bench-chart-row { display: grid; grid-template-columns: minmax(135px, 1.2fr) minmax(230px, 3fr) 53px; align-items: center; gap: 9px; }
    #mcpDbBenchmarkReport .bench-chart-label { overflow: hidden; color: var(--bench-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    #mcpDbBenchmarkReport .bench-bars { display: grid; gap: 3px; }
    #mcpDbBenchmarkReport .bench-bar-line { display: flex; align-items: center; height: 12px; gap: 5px; }
    #mcpDbBenchmarkReport .bench-bar { min-width: 2px; height: 9px; border-radius: 99px; transition: width .2s ease; }
    #mcpDbBenchmarkReport .bench-bar-mcp { background: var(--bench-mcp); }
    #mcpDbBenchmarkReport .bench-bar-db { background: var(--bench-db); }
    #mcpDbBenchmarkReport .bench-bar-value { color: var(--bench-muted); font-variant-numeric: tabular-nums; font-size: 10px; }
    #mcpDbBenchmarkReport .bench-delta { text-align: right; color: var(--bench-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
    #mcpDbBenchmarkReport .bench-delta.is-faster { color: var(--bench-db); }
    #mcpDbBenchmarkReport .bench-delta.is-slower { color: var(--bench-warn); }
    #mcpDbBenchmarkReport .bench-axis { display: flex; justify-content: space-between; margin: 10px 53px 0 144px; color: #98a2b3; font-size: 10px; }
    #mcpDbBenchmarkReport .bench-table-wrap { overflow-x: auto; }
    #mcpDbBenchmarkReport table { width: 100%; border-collapse: collapse; font-size: 11px; }
    #mcpDbBenchmarkReport th, #mcpDbBenchmarkReport td { padding: 9px 8px; border-bottom: 1px solid var(--bench-line); text-align: left; vertical-align: top; }
    #mcpDbBenchmarkReport th { color: var(--bench-muted); font-size: 10px; font-weight: 600; white-space: nowrap; }
    #mcpDbBenchmarkReport td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    #mcpDbBenchmarkReport .bench-question { min-width: 260px; color: var(--bench-ink); }
    #mcpDbBenchmarkReport .bench-table-name { display: block; margin-top: 3px; color: #98a2b3; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
    #mcpDbBenchmarkReport .bench-status { display: inline-flex; padding: 2px 7px; border-radius: 99px; font-size: 10px; white-space: nowrap; }
    #mcpDbBenchmarkReport .bench-status-ok { color: #087f6e; background: #e7f7f3; }
    #mcpDbBenchmarkReport .bench-status-control { color: var(--bench-warn); background: #fff4d6; }
    #mcpDbBenchmarkReport .bench-status-bad { color: var(--bench-bad); background: #ffeaed; }
    #mcpDbBenchmarkReport .bench-note-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    #mcpDbBenchmarkReport .bench-note { min-height: 98px; padding: 12px; border-radius: 10px; background: var(--bench-soft); }
    #mcpDbBenchmarkReport .bench-note strong { display: block; margin-bottom: 4px; font-size: 12px; }
    #mcpDbBenchmarkReport .bench-note span { color: var(--bench-muted); font-size: 11px; }
    #mcpDbBenchmarkReport .bench-callout { margin-top: 10px; padding: 11px 13px; border-left: 3px solid var(--bench-warn); background: #fffaf0; color: #6f531b; font-size: 12px; }
    #mcpDbBenchmarkReport .bench-boundary { color: var(--bench-muted); font-size: 11px; }
    @media (max-width: 720px) {
      #mcpDbBenchmarkReport .bench-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #mcpDbBenchmarkReport .bench-metric:last-child { grid-column: span 2; }
      #mcpDbBenchmarkReport .bench-chart-row { grid-template-columns: 105px minmax(155px, 1fr) 48px; gap: 6px; }
      #mcpDbBenchmarkReport .bench-axis { margin-left: 111px; }
      #mcpDbBenchmarkReport .bench-note-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 390px) {
      #mcpDbBenchmarkReport .bench-section { padding: 12px; }
      #mcpDbBenchmarkReport .bench-chart-row { grid-template-columns: 82px minmax(130px, 1fr) 43px; }
      #mcpDbBenchmarkReport .bench-axis { margin-left: 88px; }
    }
  </style>
  <section class="bench-hero">
    <div class="bench-eyebrow">CubeBuddy benchmark · analytics_db</div>
    <h1>MCP 查询 vs 直连数据库查询</h1>
    <p class="bench-subtitle">同一批示例问题、同一份测试数据、同一组聚合口径，比较 MCP 与直接连接 <code>analytics_db</code> 的可复现检索闭环表现。</p>
    <div class="bench-generated">测试时间：${generatedAt}　·　测试环境：${payload.summary.endpoint}</div>
  </section>
  <div class="bench-metrics" id="benchMetrics"></div>
  <section class="bench-section">
    <div class="bench-section-head"><div><h2>总耗时分布</h2><p>每个用例均包含一次 MCP 初始化/连接或 MySQL 新连接、查询执行和确定性答案格式化。</p></div><div class="bench-legend"><button type="button" aria-pressed="true" data-series="mcp"><span class="bench-swatch bench-swatch-mcp"></span>MCP</button><button type="button" aria-pressed="true" data-series="db"><span class="bench-swatch bench-swatch-db"></span>直连 SQL</button></div></div>
    <div class="bench-chart" id="benchLatencyChart" aria-label="MCP 与直连 SQL 各用例耗时对比"></div>
    <div class="bench-axis"><span>0 ms</span><span id="benchAxisMax"></span></div>
  </section>
  <section class="bench-section">
    <div class="bench-section-head"><div><h2>逐题结果与质量核对</h2><p>业务用例以“规范化结果逐字段一致”为客观正确性标准；陷阱对照单独标记，不计入业务一致率。</p></div></div>
    <div class="bench-table-wrap"><table><thead><tr><th>问题</th><th>MCP</th><th>直连 SQL</th><th>差值</th><th>结果质量</th><th>关键结果</th></tr></thead><tbody id="benchResultRows"></tbody></table></div>
  </section>
  <section class="bench-section">
    <div class="bench-section-head"><div><h2>结论与适用边界</h2></div></div>
    <div class="bench-note-grid">
      <div class="bench-note"><strong>结果质量</strong><span id="benchQualityNote"></span></div>
      <div class="bench-note"><strong>延迟特征</strong><span id="benchLatencyNote"></span></div>
      <div class="bench-note"><strong>工程取舍</strong><span>MCP 提供统一鉴权、工具契约和语义模型；直连 SQL 延迟更低且更灵活，但需要自行处理凭据、SQL 安全和字段语义。</span></div>
    </div>
    <div class="bench-callout"><strong>语义陷阱：</strong>资源记录的完整区域口径使用派生区域编码，例如 <code>region_code=1001</code>；仅按城市名称精确匹配可能遗漏下属区域。该差异来自查询语义，不是 MCP 与数据库执行差异。</div>
    <p class="bench-boundary"><strong>测量边界：</strong>本报告没有把真实 LLM Agent 的隐性思考时间计入，因为当前测试运行器无法取得同一 Agent 的推理起止时间。报告中的“总耗时”是可复现的检索闭环耗时；若要评价完整“输入问题 → Agent 推理 → 最终回答”，应在同一 Agent 运行器中对两个工具链增加统一埋点。</p>
  </section>
  <script>
    (() => {
      const report = ${safeJson};
      const results = report.results || [];
      const summary = report.summary || {};
      const successful = results.filter((item) => item.mcp?.ok && item.db?.ok);
      const business = successful.filter((item) => !item.comparison?.semanticControl);
      const formatMs = (value) => value == null ? "—" : String(value) + " ms";
      const formatPct = (value) => String(Math.round(Number(value || 0) * 100)) + "%";
      const metric = (label, value, note) => '<div class="bench-metric"><div class="bench-metric-label">' + label + '</div><div class="bench-metric-value">' + value + '</div><div class="bench-metric-note">' + note + '</div></div>';
      document.getElementById("benchMetrics").innerHTML = [
        metric("测试用例", summary.caseCount || results.length, String(summary.businessCaseCount || business.length) + " 个业务 + " + String(summary.semanticControlCount || 0) + " 个对照"),
        metric("业务结果一致率", formatPct(summary.exactMatchRate), String(summary.exactMatchCount || 0) + "/" + String(summary.businessCaseCount || business.length) + " 个业务用例"),
        metric("MCP 平均耗时", formatMs(summary.mcp?.meanMs), "P50 " + formatMs(summary.mcp?.p50Ms) + " · P95 " + formatMs(summary.mcp?.p95Ms)),
        metric("直连 SQL 平均耗时", formatMs(summary.db?.meanMs), "P50 " + formatMs(summary.db?.p50Ms) + " · P95 " + formatMs(summary.db?.p95Ms)),
        metric("平均耗时差", formatMs((summary.mcp?.meanMs ?? 0) - (summary.db?.meanMs ?? 0)), "正值表示 MCP 更慢"),
      ].join("");

      const maxMs = Math.max(1, ...successful.flatMap((item) => [item.mcp.totalMs, item.db.totalMs]));
      document.getElementById("benchAxisMax").textContent = String(maxMs) + " ms";
      const shortId = (id) => String(id || "").replaceAll("metadata-", "元数据·").replaceAll("shelter-", "避难场所·").replaceAll("rescue-", "救援队伍·").replaceAll("equipment-", "救援装备·").replaceAll("warehouse-", "仓储·");
      const drawChart = () => {
        const showMcp = document.querySelector('[data-series="mcp"]').getAttribute("aria-pressed") === "true";
        const showDb = document.querySelector('[data-series="db"]').getAttribute("aria-pressed") === "true";
        document.getElementById("benchLatencyChart").innerHTML = successful.map((item) => {
          const mcpWidth = Math.max(1, Math.round(item.mcp.totalMs / maxMs * 100));
          const dbWidth = Math.max(1, Math.round(item.db.totalMs / maxMs * 100));
          const delta = item.comparison.mcpMinusDbMs;
          const mcpLine = showMcp ? '<div class="bench-bar-line"><div class="bench-bar bench-bar-mcp" style="width:' + mcpWidth + '%"></div><span class="bench-bar-value">' + item.mcp.totalMs + '</span></div>' : "";
          const dbLine = showDb ? '<div class="bench-bar-line"><div class="bench-bar bench-bar-db" style="width:' + dbWidth + '%"></div><span class="bench-bar-value">' + item.db.totalMs + '</span></div>' : "";
          const deltaClass = delta > 0 ? "is-slower" : "is-faster";
          const deltaSign = delta > 0 ? "+" : "";
          return '<div class="bench-chart-row"><div class="bench-chart-label" title="' + item.question + '">' + shortId(item.id) + '</div><div class="bench-bars">' + mcpLine + dbLine + '</div><div class="bench-delta ' + deltaClass + '">' + deltaSign + delta + ' ms</div></div>';
        }).join("");
      };
      document.querySelectorAll(".bench-legend button").forEach((button) => button.addEventListener("click", () => {
        const next = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(next));
        drawChart();
      }));
      drawChart();

      const compactAnswer = (answer) => String(answer || "—").replaceAll("。", "").slice(0, 180);
      document.getElementById("benchResultRows").innerHTML = results.map((item) => {
        const mcpMs = item.mcp?.totalMs;
        const dbMs = item.db?.totalMs;
        const delta = item.comparison?.mcpMinusDbMs;
        const control = item.comparison?.semanticControl;
        const statusClass = control ? "bench-status-control" : item.comparison?.exactResultMatch ? "bench-status-ok" : "bench-status-bad";
        const status = control ? "陷阱对照" : item.comparison?.exactResultMatch ? "结果一致" : "需复核";
        const deltaClass = delta > 0 ? "is-slower" : "is-faster";
        const deltaText = delta == null ? "—" : (delta > 0 ? "+" : "") + delta + " ms";
        return '<tr><td class="bench-question">' + item.question + '<span class="bench-table-name">' + item.table + '</span></td><td class="num">' + formatMs(mcpMs) + '</td><td class="num">' + formatMs(dbMs) + '</td><td class="num ' + deltaClass + '">' + deltaText + '</td><td><span class="bench-status ' + statusClass + '">' + status + '</span></td><td title="' + (item.mcp?.answer || "") + '">' + compactAnswer(item.mcp?.answer) + '</td></tr>';
      }).join("");

      const meanDelta = (summary.mcp?.meanMs ?? 0) - (summary.db?.meanMs ?? 0);
      const relative = summary.db?.meanMs ? Math.round(meanDelta / summary.db.meanMs * 100) : 0;
      document.getElementById("benchQualityNote").textContent = String(summary.exactMatchCount || 0) + "/" + String(summary.businessCaseCount || business.length) + " 个业务用例逐字段一致；陷阱对照单独呈现。";
      document.getElementById("benchLatencyNote").textContent = "MCP 平均 " + summary.mcp?.meanMs + " ms，直连 SQL 平均 " + summary.db?.meanMs + " ms；MCP 平均" + (meanDelta >= 0 ? "多" : "少") + Math.abs(meanDelta) + " ms（约 " + Math.abs(relative) + "%）。";
    })();
  </script>
</div>
`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(outputPath);
