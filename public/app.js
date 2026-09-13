const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const state = {
  page: "datasources",
  model: "orders",
  modelTab: "基础信息",
  modelState: "applied",
  // 放弃当前页面修改后，仅隐藏这一次的状态提示；模型本身仍保留已保存草稿状态。
  modelStatusHidden: false,
  glossaryQuery: "",
  monitorLogView: "raw",
  queryOutputTab: "result",
  queryStatus: "idle",
  queryTimer: null,
  environmentDirty: false,
  mcpServer: "",
  mcpTab: "overview",
};

const meta = {
  datasources: ["语义资产", "数据源"],
  models: ["语义资产", "语义模型"],
  glossary: ["语义资产", "业务术语"],
  mcp: ["系统", "MCP 管理"],
  integrations: ["系统", "集成中心"],
  monitor: ["系统", "系统监控"]
};

const environmentConfig = {
  name: "生产环境",
  consoleDomain: "127.0.0.1",
  cubeApiUrl: "http://cube_api:4000",
  deployPath: "/opt/cube-platform",
  timezone: "Asia/Shanghai",
  imageRegistry: "docker.io",
  offlineMode: false
};

const dataSources = [
  { name: "default", desc: "默认数据源", type: "MySQL", host: "host.docker.internal", port: "3306", database: "sample_db", user: "cube_reader", models: 12, checked: "尚未检查", status: "未检查", ssl: false },
  { name: "mysql_ods", desc: "业务原始数据", type: "MySQL", host: "mysql-ods.internal", port: "3306", database: "ecommerce", user: "cube_reader", models: 8, checked: "尚未检查", status: "未检查", ssl: true },
  { name: "clickhouse_dw", desc: "分析数据仓库", type: "ClickHouse", host: "clickhouse.internal", port: "8123", database: "dw", user: "cube_reader", models: 4, checked: "尚未检查", status: "未检查", ssl: false }
];

const models = [
  { id: "orders", name: "订单分析", source: "mysql_ods.orders", status: "已加载", updated: "今天 10:42" },
  { id: "users", name: "用户分析", source: "mysql_ods.users", status: "草稿", updated: "昨天 18:06" },
  { id: "traffic", name: "流量分析", source: "clickhouse_dw.dws_traffic", status: "草稿", updated: "8 月 20 日" },
  { id: "products", name: "商品分析", source: "mysql_ods.products", status: "已加载", updated: "8 月 18 日" }
];

const defaultDimensions = [
  { title: "订单编号", name: "order_id", sql: "id", type: "string", primary: true, description: "订单唯一标识" },
  { title: "下单时间", name: "created_at", sql: "created_at", type: "time", primary: false, description: "订单创建时间" },
  { title: "订单状态", name: "status", sql: "status", type: "string", primary: false, description: "订单生命周期状态" },
  { title: "用户编号", name: "user_id", sql: "user_id", type: "string", primary: false, description: "下单用户唯一标识" },
  { title: "支付渠道", name: "payment_channel", sql: "pay_channel", type: "string", primary: false, description: "订单支付渠道" }
];

const defaultMetrics = [
  { title: "订单量", name: "order_count", type: "count", sql: "—", format: "整数", description: "有效订单总数" },
  { title: "成交金额", name: "gmv", type: "sum", sql: "paid_amount", format: "¥ 金额", description: "订单实付金额汇总" },
  { title: "客单价", name: "aov", type: "number", sql: "${gmv} / ${order_count}", format: "¥ 金额", description: "平均每单成交金额" },
  { title: "支付转化率", name: "pay_rate", type: "number", sql: "${paid_count} / ${submit_count}", format: "% 百分比", description: "提交到支付的转化率" },
  { title: "退款金额", name: "refund_amount", type: "sum", sql: "refund_amount", format: "¥ 金额", description: "成功退款金额汇总" }
];

const defaultJoins = [
  { title: "用户分析", name: "users", relationship: "many_to_one", source: "user_id", target: "id" },
  { title: "商品分析", name: "products", relationship: "many_to_one", source: "product_id", target: "id" }
];

function modelYamlText(data) {
  const form = data.form;
  return `cubes:
  - name: ${form.id}
    title: ${form.title}
    description: ${form.description}
    sql_table: ${form.source}.${form.table}
    public: ${form.public}
    refresh_key:
      every: 10 minute
    joins:
${data.joins.map(item => `      - name: ${item.name}\n        relationship: ${item.relationship}\n        sql: "{CUBE}.${item.source} = {${item.name}}.${item.target}"`).join("\n") || "      []"}
    dimensions:
${data.dimensions.map(item => `      - name: ${item.name}\n        sql: ${item.sql}\n        type: ${item.type}${item.primary ? "\n        primary_key: true" : ""}${item.public === false ? "\n        public: false" : ""}`).join("\n") || "      []"}
    measures:
${data.metrics.map(item => `      - name: ${item.name}\n        type: ${item.type}${item.sql !== "—" ? `\n        sql: ${item.sql}` : ""}${item.public === false ? "\n        public: false" : ""}`).join("\n") || "      []"}`;
}

const modelData = Object.fromEntries(models.map((model, index) => [model.id, {
  form: {
    id: model.id,
    title: model.name,
    source: model.source.split(".")[0],
    table: model.source.split(".").slice(1).join("."),
    description: index === 0 ? "统一定义订单、支付和退款分析口径，供报表与 Agent 问数复用。" : `${model.name}的统一业务语义模型。`,
    sqlSource: "物理表 sql_table",
    public: true
  },
  dimensions: defaultDimensions.map(item => ({ ...item })),
  metrics: defaultMetrics.map(item => ({ ...item })),
  joins: defaultJoins.map(item => ({ ...item }))
}]));

const modelSnapshots = {};
function snapshotModelData(data) {
  return {
    form: { ...data.form },
    dimensions: data.dimensions.map(item => ({ ...item })),
    metrics: data.metrics.map(item => ({ ...item })),
    joins: data.joins.map(item => ({ ...item })),
    // 服务器 YAML 可能包含表单未覆盖的字段，放弃修改时必须完整恢复。
    yaml: typeof data.yaml === "string" ? data.yaml : null,
    yamlEdited: data.yamlEdited === true,
    yamlDraft: data.yamlEdited === true && typeof data.yamlDraft === "string" ? data.yamlDraft : null
  };
}
function saveModelSnapshot(id = state.model) {
  const model = models.find(item => item.id === id);
  const data = modelData[id];
  if (!model || !data) return;
  modelSnapshots[id] = { model: { ...model }, data: snapshotModelData(data) };
}
function restoreModelSnapshot(id = state.model) {
  const snapshot = modelSnapshots[id];
  const model = models.find(item => item.id === id);
  const data = modelData[id];
  if (!snapshot || !model || !data) return;
  Object.assign(model, snapshot.model);
  Object.assign(data, {
    form: { ...snapshot.data.form },
    dimensions: snapshot.data.dimensions.map(item => ({ ...item })),
    metrics: snapshot.data.metrics.map(item => ({ ...item })),
    joins: snapshot.data.joins.map(item => ({ ...item })),
    yaml: typeof snapshot.data.yaml === "string" ? snapshot.data.yaml : data.yaml,
    yamlEdited: snapshot.data.yamlEdited === true,
    yamlDraft: snapshot.data.yamlEdited === true ? snapshot.data.yamlDraft : undefined
  });
}
function modelSavedState(model = currentModel()) {
  return model?.pending || model?.status === "草稿" ? "saved" : "applied";
}
models.forEach(model => saveModelSnapshot(model.id));

const glossary = [
  [["机构乙", "合作机构"], "示例机构 B", "机构", "用户分析"],
  [["水利厅", "水利部门"], "省水利厅", "机构", "订单分析"],
  [["内涝系统", "内涝平台"], "城市内涝预报验证系统", "系统", "流量分析"],
  [["GMV", "成交额", "交易额"], "成交金额", "指标", "订单分析"],
  [["客单", "平均客单"], "客单价", "指标", "订单分析"],
  [["活跃用户", "日活"], "日活跃用户数", "指标", "用户分析"]
];

function termAliases(item) {
  const aliases = Array.isArray(item?.[0]) ? item[0] : [item?.[0]];
  return [...new Set(aliases.map(alias => String(alias || "").trim()).filter(Boolean))];
}

function parseTermAliases(value) {
  return [...new Set(String(value || "").split(/[\n,，、;；]+/).map(alias => alias.trim()).filter(Boolean))];
}

function normalizeGlossaryItem(item) {
  if (Array.isArray(item)) return [termAliases(item), String(item[1] || "").trim(), item[2] || "指标", item[3] || models[0]?.name || "", String(item[4] || "").trim()];
  return [parseTermAliases(item?.aliases || item?.alias), String(item?.standard || "").trim(), item?.type || "指标", item?.model || models[0]?.name || "", String(item?.description || "").trim()];
}

const coreTools = [
  ["GET", "/cubejs-api/v1/meta", "cube_meta", "查询 Cube 模型元数据"],
  ["GET", "/cubejs-api/v1/meta/{name}", "cube_meta_detail", "按名称查询单个 Cube 元数据"],
  ["POST", "/cubejs-api/v1/load", "cube_load", "执行语义查询"],
  ["POST", "/cubejs-api/v1/search", "cube_search", "搜索模型、维度与指标"],
  ["POST", "/cubejs-api/v1/glossary-resolve", "cube_glossary_resolve", "将业务口语归一化为标准术语"],
  ["POST", "/cubejs-api/v1/sql", "cube_sql_generate", "生成查询 SQL"],
  ["POST", "/cubejs-api/v1/dry-run", "cube_dry_run", "预检查查询"],
  ["GET", "/readyz", "cube_readyz", "服务就绪检查"],
  ["GET", "/livez", "cube_livez", "服务存活检查"]
];

const queryRecords = [
  { time: "12:42:31", title: "订单量、成交金额", sub: "orders · 按订单状态", api: "REST", duration: "186 ms", source: "预聚合", status: "成功", action: "query-record-detail" },
  { time: "12:41:08", title: "活跃用户数", sub: "users · 最近 30 天", api: "REST", duration: "94 ms", source: "内存缓存", status: "成功", action: "query-record-detail" },
  { time: "12:39:17", title: "流量来源分析", sub: "traffic · page_url 字段", api: "SQL", duration: "1.82 s", source: "数据库", status: "失败", action: "query-record-error" },
  { time: "12:37:09", title: "模型元数据", sub: "/cubejs-api/v1/meta", api: "Meta", duration: "42 ms", source: "内存", status: "成功", action: "query-record-detail" }
];

const rawLogs = [
  ["12:32:16.482", "INFO", "Cube API ready on port 4002"],
  ["12:32:18.115", "INFO", "Loaded 18 cubes from schema directory"],
  ["12:32:18.421", "INFO", "Refresh worker connected"],
  ["12:34:02.017", "WARN", "traffic.page_url reference not found"],
  ["12:34:02.019", "ERROR", "Compile error in traffic.yml:24"],
  ["12:35:41.603", "INFO", "GET /readyz 200 8ms"],
  ["12:36:12.284", "INFO", "POST /cubejs-api/v1/search 200 64ms"],
  ["12:37:09.008", "INFO", "GET /cubejs-api/v1/meta 200 42ms"]
];

let modalLastFocused = null;
let drawerLastFocused = null;

function pageHead(title, _description, actions = "") {
  return `<div class="page-head"><div><h1>${title}</h1></div><div class="actions">${actions}</div></div>`;
}

function badge(status) {
  const cls = ["已加载", "正常", "健康", "成功", "有效"].includes(status) ? "green" : status === "草稿" || ["有风险", "执行中"].includes(status) ? "orange" : ["待应用", "未检查"].includes(status) ? "gray" : ["异常", "失败", "已过期"].includes(status) ? "red" : "purple";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function modelStatusDot(status) {
  const loaded = status === "已加载";
  const label = loaded ? "已加载" : "草稿";
  return `<span class="model-status-dot ${loaded ? "loaded" : "draft"}" role="img" aria-label="${label}" title="${label}"></span>`;
}

function modelVisibilityButton(isPublic) {
  return `<button type="button" class="model-visibility-button ${isPublic ? "active" : "inactive"}" aria-label="${isPublic ? "关闭公开" : "开启公开"}" aria-pressed="${isPublic}" data-action="toggle-public">${isPublic ? "启用" : "停用"}</button>`;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = `✓　${message}`;
  node.classList.add("show");
  clearTimeout(window.__cubeToast);
  window.__cubeToast = setTimeout(() => node.classList.remove("show"), 2300);
}

function copyText(text, successMessage) {
  const done = () => toast(successMessage);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => copyTextFallback(text, done));
    return;
  }
  copyTextFallback(text, done);
}

function copyTextFallback(text, done) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
  done();
}

function trapFocus(container, event) {
  if (event.key !== "Tab") return;
  const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container).filter(item => item.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openModal({ title, sub = "", icon = "◇", body = "", confirm = "确认", wide = false, modalClass = "", onConfirm, afterOpen }) {
  modalLastFocused = document.activeElement;
  const modal = $("#modal");
  modal.classList.toggle("wide", wide);
  modal.classList.toggle("auto-model-modal", modalClass === "auto-model-modal");
  modal.classList.toggle("source-modal", modalClass === "source-modal");
  $("#modalIcon").textContent = icon;
  $("#modalTitle").textContent = title;
  $("#modalSub").textContent = sub;
  $("#modalBody").innerHTML = body;
  if ($("#modalFootNote")) $("#modalFootNote").textContent = "";
  $("#modalConfirm").textContent = confirm;
  $("#modalConfirm").disabled = false;
  $("#modalCancel").disabled = false;
  $("#modalClose").disabled = false;
  $("#modalConfirm").onclick = () => onConfirm ? onConfirm() : closeModal();
  $("#overlay").classList.add("show");
  $$('[data-action]', $("#modalBody")).forEach(button => button.onclick = () => handleAction(button.dataset.action, button));
  setTimeout(() => {
    const firstField = $('input,select,textarea,button:not(.modal-close)', modal);
    (firstField || modal).focus();
    if (afterOpen) afterOpen();
  });
}

function closeModal() {
  if (!$("#overlay").classList.contains("show")) return;
  $("#overlay").classList.remove("show");
  if (modalLastFocused?.focus) modalLastFocused.focus();
}

function setModalBusy(label = "应用中…") {
  const confirm = $("#modalConfirm");
  const cancel = $("#modalCancel");
  const close = $("#modalClose");
  if (confirm) { confirm.disabled = true; confirm.textContent = label; }
  if (cancel) cancel.disabled = true;
  if (close) close.disabled = true;
}

function restoreModalActions(confirmLabel) {
  const confirm = $("#modalConfirm");
  const cancel = $("#modalCancel");
  const close = $("#modalClose");
  if (confirm) { confirm.disabled = false; confirm.textContent = confirmLabel; }
  if (cancel) cancel.disabled = false;
  if (close) close.disabled = false;
}

function modelStateInfo() {
  return {
    applied: { title: "已应用", description: "当前模型与 Cube 已加载版本一致", cls: "state-applied" },
    dirty: { title: "有未保存修改", description: "", cls: "state-dirty" },
    saved: { title: "草稿已保存，点击「发布」更新服务", description: "", cls: "state-draft" },
    validating: { title: "正在校验", description: "正在检查 YAML、字段引用与 Cube 元数据", cls: "state-saved" },
    saving: { title: "正在保存", description: "正在校验并写入模型文件", cls: "state-saved" },
    applying: { title: "正在应用", description: "正在重新加载模型并执行健康检查", cls: "state-saved" },
    error: { title: "校验失败", description: "请修复错误后再应用", cls: "state-error" }
  }[state.modelState];
}

function setModelState(next, rerender = false) {
  state.modelState = next;
  // 一旦开始新的编辑或保存流程，重新显示状态提示。
  if (["dirty", "saved", "validating", "saving", "applying", "error"].includes(next)) state.modelStatusHidden = false;
  // Keep the same textarea node on the first edit so the browser's native
  // Command/Ctrl+Z undo history is not lost by a full render.
  if (rerender) return render();
  const info = modelStateInfo();
  $$('[data-model-state-title]').forEach(node => node.textContent = info.title);
  $$('[data-model-state-desc]').forEach(node => node.textContent = info.description);
  $$('[data-model-state-pill]').forEach(node => {
    node.textContent = info.title;
    node.className = `state-pill ${info.cls}`;
  });
  $$(".status-strip").forEach(node => {
    node.classList.toggle("warn", state.modelState === "dirty");
    node.classList.toggle("draft", state.modelState === "saved");
    node.classList.toggle("hidden", state.modelStatusHidden || state.modelState === "applied");
  });
  $$('[data-action="save-draft"]').forEach(button => {
    const canSave = state.modelState === "dirty";
    button.classList.toggle("hidden", !canSave);
    button.disabled = !canSave;
  });
  refreshModelPublishButton();
  $$('[data-action="discard-model"]').forEach(button => button.classList.toggle("hidden", state.modelState !== "dirty"));
}

function refreshModelPublishButton() {
  const count = modelDraftCount();
  const blocked = !canApplyModels();
  $$('[data-action="apply-models"]').forEach(button => {
    button.disabled = blocked;
    button.title = state.modelState === "dirty" ? "请先保存当前模型修改" : count ? `将应用 ${count} 个草稿` : "暂无待应用草稿";
  });
}

function updateVisibilityToggle(button, isPublic, busy = false) {
  if (!button) return;
  button.classList.toggle("on", isPublic);
  button.setAttribute("aria-pressed", String(isPublic));
  button.setAttribute("aria-label", isPublic ? "关闭公开" : "开启公开");
  button.disabled = busy;
}

function updateModelVisibilityToggle(isPublic, busy = false) {
  const button = $(".model-visibility-button");
  if (!button) return;
  button.textContent = isPublic ? "启用" : "停用";
  button.classList.toggle("active", isPublic);
  button.classList.toggle("inactive", !isPublic);
  updateVisibilityToggle(button, isPublic, busy);
}

function currentModel() {
  return models.find(model => model.id === state.model) || models[0];
}

function currentModelData() {
  const model = currentModel();
  return model ? modelData[model.id] : null;
}

function renderDatasources() {
  const rows = dataSources.map((source, index) => `<tr>
    <td class="source-name-cell"><div class="entity"><span><strong>${escapeHtml(source.name)}</strong></span></div></td>
    <td>${escapeHtml(source.type)}</td><td class="mono">${escapeHtml(source.host)}:${escapeHtml(source.port)}</td><td>${escapeHtml(source.database)}</td><td>${source.models}</td><td class="source-status-cell">${badge(source.status)}</td>
    <td><button class="link" data-action="edit-source" data-index="${index}">编辑</button>　<button class="link" data-action="test-source" data-index="${index}">测试</button>　<button class="link bad" data-action="delete-source" data-index="${index}">删除</button></td>
  </tr>`).join("");
  const body = rows || '<tr><td colspan="7"><div class="empty"><b>暂无数据源</b></div></td></tr>';
  return pageHead("数据源", "管理数据库连接，保存后自动应用到 Cube。", `<div class="actions"><button class="btn primary" data-action="new-source">＋ 新增</button></div>`) +
    `<section class="card"><div class="card-head"><div><h2>数据源列表</h2></div></div>
    <div class="table-wrap"><table class="table datasources-table"><colgroup><col style="width:20%"><col style="width:9%"><col style="width:22%"><col style="width:13%"><col style="width:10%"><col style="width:13%"><col style="width:13%"></colgroup><thead><tr><th>数据源</th><th>类型</th><th>连接地址</th><th>数据库</th><th>关联模型</th><th>状态</th><th>操作</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function modelFooter() {
  return "";
}

function modelActionButtons() {
  const canSave = state.modelState === "dirty";
  return `<div class="actions model-state-actions">
    <button class="btn ${state.modelState === "dirty" ? "" : "hidden"}" data-action="discard-model">还原</button>
    <button class="btn ${canSave ? "" : "hidden"}" data-action="save-draft" ${canSave ? "" : "disabled"}>保存</button>
  </div>`;
}

function modelDraftCount() {
  return models.filter(model => model.pending === true || model.status === "草稿").length;
}

function canApplyModels() {
  return modelDraftCount() > 0 && !["dirty", "saving", "applying"].includes(state.modelState);
}

function globalModelApplyButton() {
  const count = modelDraftCount();
  const disabled = !canApplyModels();
  const hint = state.modelState === "dirty" ? "请先保存当前模型修改" : count ? `将应用 ${count} 个草稿` : "暂无待应用草稿";
  const label = state.modelState === "applying" ? "发布中…" : "发布";
  return `<button class="btn primary" data-action="apply-models" ${disabled ? "disabled" : ""} title="${hint}">${label}</button>`;
}

function modelHeaderActions() {
  return `${globalModelApplyButton()}<button class="btn" data-action="auto-model">自动建模</button><button class="btn" data-action="new-model">新建模型</button><div class="model-more"><button class="btn" data-action="toggle-model-more" aria-expanded="false">更多 ▾</button><div class="model-more-menu hidden"><button class="btn" data-action="import-model">导入模型</button><button class="btn" data-action="export-model">导出模型</button></div></div>`;
}

function modelSourceSelect(form) {
  const selected = dataSources.some(source => source.name === form.source) ? form.source : "";
  const options = [{ value: "", label: "不绑定数据源" }, ...dataSources.map(source => ({ value: source.name, label: source.name }))];
  const selectedLabel = options.find(option => option.value === selected)?.label || "不绑定数据源";
  return `<div class="model-source-select">
    <input type="hidden" data-model-field="source" value="${escapeHtml(selected)}">
    <button class="model-source-trigger" type="button" role="combobox" aria-label="数据源" aria-controls="model-source-options" aria-expanded="false" aria-haspopup="listbox" data-action="toggle-model-source"><span data-model-source-label>${escapeHtml(selectedLabel)}</span><i aria-hidden="true"></i></button>
    <ul class="model-source-menu" id="model-source-options" role="listbox" aria-label="数据源" hidden>${options.map(option => `<li class="model-source-option" role="option" aria-selected="${option.value === selected}" data-value="${escapeHtml(option.value)}" data-label="${escapeHtml(option.label)}" data-action="select-model-source">${option.value === selected ? "✓" : ""}<span>${escapeHtml(option.label)}</span></li>`).join("")}</ul>
  </div>`;
}

function modelBasics(model, data) {
  const form = data.form;
  return `<div class="model-form"><div class="model-grid">
    <label class="field">模型名称<input data-model-field="id" value="${escapeHtml(form.id)}" readonly><small>模型名称创建后不可修改</small></label>
    <label class="field">业务标题<input data-model-field="title" value="${escapeHtml(form.title)}"></label>
    <label class="field">数据源${modelSourceSelect(form)}</label>
    <label class="field">物理表<input data-model-field="table" class="mono" value="${escapeHtml(form.table)}"></label>
    <label class="field wide">业务描述<textarea data-model-field="description">${escapeHtml(form.description)}</textarea></label>
  </div>${modelFooter()}</div>`;
}

function captureMemberTableScroll(element) {
  const container = element?.closest?.(".member-table-scroll") || $(".member-table-scroll");
  return container ? { top: container.scrollTop, left: container.scrollLeft } : null;
}

function restoreMemberTableScroll(position) {
  if (!position) return;
  const container = $(".member-table-scroll");
  if (!container) return;
  container.scrollTop = position.top;
  container.scrollLeft = position.left;
}

function modelDimensions(data) {
  const rows = data.dimensions.map((item, index) => `<tr><td><strong>${escapeHtml(item.title)}</strong><small class="mono">${escapeHtml(item.name)}</small></td><td class="mono">${escapeHtml(item.sql)}</td><td><span class="badge purple">${escapeHtml(item.type)}</span></td><td>${item.primary ? "是" : "否"}</td><td>${escapeHtml(item.description)}</td><td><div class="member-actions"><label class="member-exposure"><button class="toggle member-toggle ${item.public !== false ? "on" : ""}" aria-label="${item.public !== false ? "关闭" : "开启"}${escapeHtml(item.title)}对外暴露" aria-pressed="${item.public !== false}" data-action="toggle-member-public" data-kind="dimensions" data-index="${index}" title="${item.public !== false ? "关闭对外暴露" : "开启对外暴露"}"><i></i></button></label><span class="member-actions-divider"></span><button class="link" data-action="edit-dimension" data-index="${index}">编辑</button></div></td></tr>`).join("");
  return `<div class="toolbar"><div><strong>维度</strong></div></div><div class="member-table-scroll"><table class="table"><thead><tr><th>维度</th><th>字段 / SQL</th><th>类型</th><th>主键</th><th>说明</th><th class="member-actions-col">可见性</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty"><b>暂无维度</b>请先在数据源侧创建字段，再重新建模</div></td></tr>'}</tbody></table></div>${modelFooter()}`;
}

function modelMetrics(data) {
  const rows = data.metrics.map((item, index) => `<tr><td><div class="entity"><span class="metric-symbol">#</span><span><strong>${escapeHtml(item.title)}</strong><small class="mono">${escapeHtml(item.name)}</small></span></div></td><td><span class="badge purple">${escapeHtml(item.type)}</span></td><td class="mono">${escapeHtml(item.sql)}</td><td>${escapeHtml(item.format)}</td><td>${escapeHtml(item.description)}</td><td><div class="member-actions"><label class="member-exposure"><button class="toggle member-toggle ${item.public !== false ? "on" : ""}" aria-label="${item.public !== false ? "关闭" : "开启"}${escapeHtml(item.title)}对外暴露" aria-pressed="${item.public !== false}" data-action="toggle-member-public" data-kind="metrics" data-index="${index}" title="${item.public !== false ? "关闭对外暴露" : "开启对外暴露"}"><i></i></button></label><span class="member-actions-divider"></span><button class="link" data-action="edit-metric" data-index="${index}">编辑</button><button class="link bad" data-action="delete-member" data-kind="metrics" data-index="${index}">删除</button></div></td></tr>`).join("");
  return `<div class="member-table-scroll"><table class="table"><thead><tr><th>指标</th><th>类型</th><th>字段 / SQL</th><th>格式</th><th>说明</th><th class="member-actions-col">可见性</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty"><b>暂无指标</b>点击“新建指标”开始配置</div></td></tr>'}</tbody></table></div>${modelFooter()}`;
}

function modelJoins(model, data) {
  const first = data.joins[0];
  const map = first ? `<div class="relation-map"><div class="cube-node active"><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.id)} · 当前模型</small></div><div class="join-line"><span>${escapeHtml(first.relationship)}</span><i></i><b>${escapeHtml(first.source)} = ${escapeHtml(first.target)}</b></div><div class="cube-node"><strong>${escapeHtml(first.title)}</strong><small>${escapeHtml(first.name)} · 目标模型</small></div></div>` : "";
  const rows = data.joins.map((item, index) => `<tr><td><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.name)}</small></td><td>${escapeHtml(item.relationship)}</td><td class="mono">${escapeHtml(item.source)}</td><td class="mono">${escapeHtml(item.target)}</td><td>${badge("正常")}</td><td><button class="link" data-action="edit-join" data-index="${index}">编辑</button>　<button class="link" data-action="delete-member" data-kind="joins" data-index="${index}">删除</button></td></tr>`).join("");
  return `<div class="toolbar"><div><strong>关联</strong><small style="display:block">用字段配置关系，系统自动生成 Join SQL</small></div><button class="btn primary small" data-action="new-join">＋ 新增关联</button></div>${map}<div class="table-wrap" style="border:1px solid var(--line);border-radius:7px"><table class="table"><thead><tr><th>关联模型</th><th>关系</th><th>来源字段</th><th>目标字段</th><th>检查结果</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty"><b>暂无关联</b>可按需新增模型关系</div></td></tr>'}</tbody></table></div>${modelFooter()}`;
}


function renderModels() {
  const model = currentModel();
  const data = currentModelData();
  if (!model || !data) {
    return pageHead("语义模型", "用表单维护常用配置，复杂能力保留 YAML。", modelHeaderActions()) +
      '<section class="card empty-page"><div class="empty"><b>暂无语义模型</b><span>请使用页面右上角的“自动建模”或“新建模型”开始配置。</span></div></section>';
  }
  const info = modelStateInfo();
  const tabs = ["基础信息", "维度", "指标", "关联", "YAML"];
  const counts = { 维度: data.dimensions.length, 指标: data.metrics.length, 关联: data.joins.length };
  const content = state.modelTab === "基础信息" ? modelBasics(model, data) : state.modelTab === "维度" ? modelDimensions(data) : state.modelTab === "指标" ? modelMetrics(data) : state.modelTab === "关联" ? modelJoins(model, data) : modelYaml(model, data);
  return pageHead("语义模型", "用表单维护常用配置，复杂能力保留 YAML。", modelHeaderActions()) +
    `<select class="search-input mobile-model-select" id="mobileModelSelect" aria-label="选择模型">${models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === model.id ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.id)}</option>`).join("")}</select>
    <div class="model-workbench"><aside class="model-browser"><div class="model-browser-head"><strong>模型</strong><div class="model-browser-head-actions"><span class="muted">${models.length}</span><div class="model-more model-add"><button class="model-add-button" data-action="toggle-model-more" aria-expanded="false" aria-label="新建模型">＋</button><div class="model-more-menu hidden"><button class="btn" data-action="new-model">新建</button><button class="btn" data-action="auto-model">自动建模</button></div></div></div></div><div class="model-search">⌕<input id="modelSearch" placeholder="搜索模型" aria-label="搜索模型"></div><div class="model-list">${models.map(item => `<button class="model-item ${item.id === model.id ? "active" : ""}" data-model="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span>${modelStatusDot(item.status)}</button>`).join("")}</div></aside>
    <section class="model-detail"><div class="model-titlebar"><div class="model-titlebar-main"><div class="model-title"><div><div class="actions"><h2>${escapeHtml(model.name)}</h2></div><p>${escapeHtml(model.source)} · ${escapeHtml(model.updated)}</p></div></div><div class="status-strip ${state.modelState === "dirty" ? "warn" : ""} ${state.modelState === "saved" ? "draft" : ""} ${state.modelStatusHidden || state.modelState === "applied" ? "hidden" : ""}"><div class="model-status-copy"><div><span class="state-pill ${info.cls}" data-model-state-pill>${info.title}</span>${info.description ? `<span class="model-state-desc" data-model-state-desc>${info.description}</span>` : ""}</div>${state.modelTab === "YAML" ? '<span class="model-file-note">真实文件 · 自动校验与备份</span>' : ""}</div>${modelActionButtons()}</div></div><div class="actions">${modelVisibilityButton(data.form.public)}<button class="btn small" data-action="remodel-model">重建</button><button class="btn small" data-action="validate-model">校验</button><button class="btn danger small" data-action="delete-model">删除</button></div></div>
    <nav class="tabs">${tabs.map(tab => `<button class="${tab === state.modelTab ? "active" : ""}" data-model-tab="${tab}">${tab}${counts[tab] !== undefined ? ` ${counts[tab]}` : ""}</button>`).join("")}</nav><div class="model-panel">${content}</div></section></div>`;
}

function queryOutputTabs() {
  return `<div class="query-output-tabs"><button class="${state.queryOutputTab === "result" ? "active" : ""}" data-query-tab="result">查询结果</button><button class="${state.queryOutputTab === "json" ? "active" : ""}" data-query-tab="json">JSON Query</button><button class="${state.queryOutputTab === "sql" ? "active" : ""}" data-query-tab="sql">生成 SQL</button></div>`;
}


function renderQueryOutput() {
  const output = $("#queryOutput");
  if (output) output.innerHTML = queryOutputContent();
}

function updateQueryRunState() {
  const count = $$('.query-member:checked', $("#queryDrawer")).length;
  const button = $("#runQueryBtn");
  if (button) button.disabled = count === 0 || state.queryStatus === "loading";
}


function closeQueryDrawer() {
  if (!$("#queryDrawer").classList.contains("show")) return;
  clearTimeout(state.queryTimer);
  $("#drawerBackdrop").classList.remove("show");
  $("#queryDrawer").classList.remove("show");
  if (drawerLastFocused?.focus) drawerLastFocused.focus();
}

function renderGlossary() {
  const query = state.glossaryQuery.trim().toLocaleLowerCase("zh-CN");
  const rows = glossary.map((item, index) => {
    const aliases = termAliases(item);
    const searchText = [...aliases, item[1], item[4]].join(" ").toLocaleLowerCase("zh-CN");
    return { item, index, aliases, searchText, visible: !query || searchText.includes(query) };
  });
  const visibleCount = rows.filter(row => row.visible).length;
  const actions = `<input class="search-input glossary-page-search" id="glossSearch" placeholder="搜索描述、别名或标准术语" value="${escapeHtml(state.glossaryQuery)}"><button class="btn" data-action="export-glossary">导出术语</button><button class="btn" data-action="choose-glossary-import">导入术语</button><button class="btn primary" data-action="new-term">＋ 新增术语</button>`;
  return pageHead("业务术语", "一个标准术语可配置多个口语别名和业务定义。", actions) +
    `<input class="hidden" id="glossaryImportInput" type="file" accept=".json,.csv,.txt,application/json,text/csv,text/plain"><div class="card glossary-card"><div class="table-wrap"><table class="table glossary-table"><colgroup><col style="width:22%"><col style="width:56%"><col style="width:12%"><col style="width:120px"></colgroup><thead><tr><th>标准术语</th><th>术语描述</th><th>别名</th><th>操作</th></tr></thead><tbody>${rows.map(({ item, index, aliases, searchText, visible }) => `<tr data-glossary-row data-glossary-text="${escapeHtml(searchText)}"${visible ? "" : " hidden"}><td class="glossary-standard-cell" title="${escapeHtml(item[1])}"><strong>${escapeHtml(item[1])}</strong></td><td class="glossary-description-cell" title="${escapeHtml(item[4] || "暂无描述")}">${item[4] ? escapeHtml(item[4]) : '<span class="muted">暂无描述</span>'}</td><td class="glossary-alias-cell">${aliases.map(alias => `<span class="term-chip">${escapeHtml(alias)}</span>`).join("")}</td><td class="glossary-actions-cell"><button class="link" data-action="edit-term" data-index="${index}">编辑</button>　<button class="link" data-action="delete-term" data-index="${index}">删除</button></td></tr>`).join("")}<tr id="glossaryNoResults"${visibleCount ? " hidden" : ""}><td colspan="4"><div class="empty"><b>未找到术语</b></div></td></tr></tbody></table></div></div>`;
}

function filterGlossaryRows(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase("zh-CN");
  let visibleCount = 0;
  $$('[data-glossary-row]').forEach(row => {
    const visible = !normalized || row.dataset.glossaryText.includes(normalized);
    row.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const emptyRow = $("#glossaryNoResults");
  if (emptyRow) emptyRow.hidden = visibleCount > 0;
}




function render() {
  const pageMeta = meta[state.page];
  if ($("#crumbGroup")) $("#crumbGroup").textContent = pageMeta[0];
  if ($("#crumbPage")) $("#crumbPage").textContent = pageMeta[1];
  $$('[data-page]').forEach(button => button.classList.toggle("active", button.dataset.page === state.page));
  const renderer = { datasources: renderDatasources, models: renderModels, glossary: renderGlossary, mcp: renderMcpManagement, integrations: renderIntegrations, monitor: renderMonitor }[state.page];
  $("#pageRoot").classList.toggle("model-page-shell", state.page === "models");
  $("#pageRoot").innerHTML = renderer();
  bindPage();
}

function gotoPage(page) {
  if (!meta[page]) return;
  state.page = page;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function sourceModal(index = null) {
  const editing = index !== null && dataSources[index];
  const source = editing || { name: "", desc: "", type: "MySQL", host: "", port: "3306", database: "", user: "root", models: 0, checked: "尚未检查", status: "未检查", ssl: false };
  openModal({
    title: editing ? "编辑数据源" : "添加数据源",
    sub: "保存为待应用配置，连接测试通过后再应用到 Cube。",
    icon: "",
    wide: true,
    modalClass: "source-modal",
    confirm: "保存配置",
    body: `<div class="source-modal-form"><div class="grid cols-2"><label class="field">数据源名称<input id="sourceName" value="${escapeHtml(source.name)}" placeholder="analytics"></label><label class="field">说明<input id="sourceDesc" value="${escapeHtml(source.desc)}" placeholder="业务分析数据"></label><label class="field">数据库类型<select id="sourceType">${["MySQL", "PostgreSQL", "ClickHouse"].map(type => `<option ${type === source.type ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field">主机<input id="sourceHost" value="${escapeHtml(source.host)}" placeholder="例如 127.0.0.1"></label><label class="field">端口<input id="sourcePort" value="${escapeHtml(source.port)}"></label><label class="field">数据库名<input id="sourceDatabase" value="${escapeHtml(source.database)}" placeholder="ecommerce"></label><label class="field">用户名<input id="sourceUser" value="${escapeHtml(source.user)}" autocomplete="username"></label><label class="field">密码<input type="password" placeholder="留空则保持不变" autocomplete="new-password"></label></div><label class="source-ssl-row"><span class="source-ssl-copy"><strong>SSL 连接</strong><small>需要数据库服务端支持 SSL 时开启</small></span><input id="sourceSsl" type="checkbox" ${source.ssl ? "checked" : ""}></label></div>`,
    onConfirm: () => {
      const name = $("#sourceName").value.trim();
      const host = $("#sourceHost").value.trim();
      if (!name || !host) return toast("请填写数据源名称和主机");
      const next = { ...source, name, desc: $("#sourceDesc").value.trim() || "业务数据源", type: $("#sourceType").value, host, port: $("#sourcePort").value.trim(), database: $("#sourceDatabase").value.trim(), user: $("#sourceUser").value.trim(), ssl: $("#sourceSsl").checked, checked: "尚未检查", status: "未检查" };
      if (editing) dataSources[index] = next; else dataSources.push(next);
      closeModal();
      render();
      toast(editing ? "数据源已更新，请点击测试" : "数据源已新增，请点击测试");
    }
  });
}

function newModelModal() {
  openModal({ title: "新建语义模型", sub: "创建后进入可视化编辑器继续配置维度、指标和关联。", icon: "◇", confirm: "创建模型", body: `<div class="grid cols-2"><label class="field">模型名称<input id="newModelId" placeholder="例如 payments"></label><label class="field">业务标题<input id="newModelTitle" placeholder="例如 支付分析"></label><label class="field">数据源<select id="newModelSource">${dataSources.map(item => `<option>${item.name}</option>`).join("")}</select></label><label class="field">物理表<input id="newModelTable" placeholder="例如 payments"></label></div>`, onConfirm: () => {
    const id = $("#newModelId").value.trim();
    const title = $("#newModelTitle").value.trim();
    const table = $("#newModelTable").value.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(id) || !title || !table) return toast("请完整填写，模型名称使用 snake_case");
    if (models.some(item => item.id === id)) return toast("模型名称已存在");
    const source = $("#newModelSource").value;
    models.push({ id, name: title, source: `${source}.${table}`, status: "草稿", updated: "刚刚" });
    modelData[id] = { form: { id, title, source, table, description: "", sqlSource: "物理表 sql_table", public: true }, dimensions: [], metrics: [], joins: [] };
    saveModelSnapshot(id);
    state.model = id;
    state.modelTab = "基础信息";
    state.modelState = "dirty";
    closeModal();
    render();
    toast("模型草稿已创建");
  } });
}

function memberModal(kind, index = null) {
  const data = currentModelData();
  const editing = index !== null && data[kind][index];
  if (kind === "dimensions") {
    if (!editing) return toast("维度字段由数据源管理，请先在数据源侧创建字段，再重新建模");
    const item = editing;
    openModal({ title: "编辑维度展示信息", sub: "字段名称、SQL、类型和主键由数据源管理；如需变更，请修改数据源后重新建模。", icon: "D", wide: true, confirm: "保存维度", body: `<div class="grid cols-2"><label class="field">名称<input id="memberName" value="${escapeHtml(item.name)}" readonly></label><label class="field">业务标题<input id="memberTitle" value="${escapeHtml(item.title)}"></label><label class="field">字段 / SQL<input id="memberSql" class="mono" value="${escapeHtml(item.sql)}" readonly></label><label class="field">类型<input id="memberType" value="${escapeHtml(item.type)}" readonly></label><label class="field" style="grid-column:1/-1">描述<textarea id="memberDescription">${escapeHtml(item.description)}</textarea></label></div><div class="member-modal-switch"><span><strong>对外暴露</strong><small>关闭后不会出现在 Cube 元数据和查询选项中</small></span><button class="toggle ${item.public !== false ? "on" : ""}" id="memberPublic" aria-pressed="${item.public !== false}"><i></i></button></div><label class="checkline" style="margin-top:14px"><input id="memberPrimary" type="checkbox" ${item.primary ? "checked" : ""} disabled> 主键由数据源管理</label>`, afterOpen: () => { $("#memberPrimary")?.closest(".checkline")?.remove(); $("#memberPublic").onclick = () => { const next = $("#memberPublic").getAttribute("aria-pressed") !== "true"; $("#memberPublic").classList.toggle("on", next); $("#memberPublic").setAttribute("aria-pressed", String(next)); }; }, onConfirm: () => saveMember(kind, index, { name: item.name, title: $("#memberTitle").value.trim(), sql: item.sql, type: item.type, description: $("#memberDescription").value.trim(), primary: item.primary, public: $("#memberPublic").getAttribute("aria-pressed") === "true" }) });
    return;
  }
  if (kind === "metrics") {
    const item = editing || { title: "", name: "", type: "sum", sql: "", format: "整数", public: true, description: "" };
    openModal({ title: editing ? "编辑指标" : "新建指标", sub: "支持常用聚合类型，高级能力保留在 YAML。", icon: "#", wide: true, confirm: "保存指标", body: `<div class="grid cols-2"><label class="field">名称<input id="memberName" value="${escapeHtml(item.name)}"></label><label class="field">业务标题<input id="memberTitle" value="${escapeHtml(item.title)}"></label><label class="field">类型<select id="memberType">${["sum", "count", "avg", "min", "max", "count_distinct", "number"].map(type => `<option ${type === item.type ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field">字段 / SQL<input id="memberSql" class="mono" value="${escapeHtml(item.sql)}"></label><label class="field">展示格式<select id="memberFormat">${["¥ 金额", "整数", "% 百分比", "小数"].map(format => `<option ${format === item.format ? "selected" : ""}>${format}</option>`).join("")}</select></label><label class="field" style="grid-column:1/-1">业务描述<textarea id="memberDescription">${escapeHtml(item.description)}</textarea></label></div><div class="member-modal-switch"><span><strong>对外暴露</strong><small>关闭后不会出现在 Cube 元数据和查询选项中</small></span><button class="toggle ${item.public !== false ? "on" : ""}" id="memberPublic" aria-pressed="${item.public !== false}"><i></i></button></div>`, afterOpen: () => { $("#memberPublic").onclick = () => { const next = $("#memberPublic").getAttribute("aria-pressed") !== "true"; $("#memberPublic").classList.toggle("on", next); $("#memberPublic").setAttribute("aria-pressed", String(next)); }; }, onConfirm: () => saveMember(kind, index, { name: $("#memberName").value.trim(), title: $("#memberTitle").value.trim(), type: $("#memberType").value, sql: $("#memberSql").value.trim() || "—", format: $("#memberFormat").value, description: $("#memberDescription").value.trim(), public: $("#memberPublic").getAttribute("aria-pressed") === "true" }) });
    return;
  }
  const item = editing || { title: "用户分析", name: "users", relationship: "many_to_one", source: "user_id", target: "id" };
  openModal({ title: editing ? "编辑模型关联" : "新增模型关联", sub: "选择字段后自动生成 Join SQL 并检查关系方向。", icon: "↔", wide: true, confirm: "保存关联", body: `<div class="grid cols-2"><label class="field">目标模型<select id="joinModel">${models.filter(model => model.id !== state.model).map(model => `<option value="${model.id}" ${model.id === item.name ? "selected" : ""}>${model.name}（${model.id}）</option>`).join("")}</select></label><label class="field">关系类型<select id="joinRelationship">${["many_to_one", "one_to_one", "one_to_many"].map(type => `<option ${type === item.relationship ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field">来源字段<input id="joinSource" value="${escapeHtml(item.source)}"></label><label class="field">目标字段<input id="joinTarget" value="${escapeHtml(item.target)}"></label></div>`, onConfirm: () => {
    const target = models.find(model => model.id === $("#joinModel").value);
    saveMember(kind, index, { title: target.name, name: target.id, relationship: $("#joinRelationship").value, source: $("#joinSource").value.trim(), target: $("#joinTarget").value.trim() });
  } });
}

function syncCubeYamlField(source, field, value, { removeWhenEmpty = false } = {}) {
  const text = String(source || "");
  if (!text.trim()) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const cubeIndex = lines.findIndex((line) => /^\s*-\s+name\s*:/.test(line));
  if (cubeIndex < 0) return text;
  const itemIndent = lines[cubeIndex].match(/^[ \t]*/)?.[0] || "";
  const propertyIndent = `${itemIndent}  `;
  const nextCubeOrRoot = lines.findIndex((line, index) => {
    if (index <= cubeIndex || !line.trim()) return false;
    const indent = line.match(/^[ \t]*/)?.[0] || "";
    return indent.length <= itemIndent.length && !line.trim().startsWith("#");
  });
  const cubeEnd = nextCubeOrRoot < 0 ? lines.length : nextCubeOrRoot;
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldPattern = new RegExp(`^${propertyIndent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${escapedField}\\s*:`);
  const fieldIndex = lines.findIndex((line, index) => index > cubeIndex && index < cubeEnd && fieldPattern.test(line));
  if (removeWhenEmpty && !String(value || "").trim()) {
    if (fieldIndex >= 0) lines.splice(fieldIndex, 1);
    return lines.join(newline);
  }
  const nextLine = `${propertyIndent}${field}: ${yamlPreviewScalar(value)}`;
  if (fieldIndex >= 0) lines[fieldIndex] = nextLine;
  else lines.splice(cubeIndex + 1, 0, nextLine);
  return lines.join(newline);
}

function syncModelYamlFields(source, data) {
  let next = String(source || "");
  if (!next.trim()) return next;
  const cubeIndex = next.split(/\r?\n/).findIndex((line) => /^\s*-\s+name\s*:/.test(line));
  if (cubeIndex < 0) return next;
  const lines = next.split(/\r?\n/);
  const indent = lines[cubeIndex].match(/^[ \t]*/)?.[0] || "";
  lines[cubeIndex] = `${indent}- name: ${yamlPreviewScalar(data.form.id)}`;
  next = lines.join(next.includes("\r\n") ? "\r\n" : "\n");
  next = syncCubeYamlField(next, "title", data.form.title);
  next = syncCubeYamlField(next, "description", data.form.description);
  next = syncCubeYamlField(next, "sql_table", data.form.table);
  return syncCubeYamlField(next, "data_source", data.form.source, { removeWhenEmpty: !data.form.source || data.form.source === "default" });
}

function syncYamlPreview(data, kind) {
  const yamlEditor = $("#yamlEditor");
  // YAML 页以编辑器内容为当前草稿源。先吸收编辑器里的未保存修改，
  // 避免切换可见性时用旧的 data.yaml 覆盖用户刚编辑的内容。
  if (yamlEditor) data.yaml = yamlEditor.value;

  if (kind === "model") {
    // YAML 是表单和保存接口的唯一事实源；基础信息修改先回写 YAML，
    // 再由保存流程把同一份文档提交给服务端。
    data.yaml = syncModelYamlFields(data.yaml, data);
    data.yaml = syncModelPublicYaml(data.yaml, data.form.public);
    if (yamlEditor) yamlEditor.value = data.yaml;
  }

  data.yamlEdited = false;
  data.yamlDraft = undefined;
  if (typeof syncStructuredYamlPreview === "function") {
    const next = syncStructuredYamlPreview(data, kind);
    if (typeof next === "string" && next.trim()) data.yaml = next;
  }
  if (yamlEditor && yamlEditor.value !== data.yaml) yamlEditor.value = data.yaml;
  // The real runtime keeps a parsed document alongside the view model. Keep
  // that document in sync immediately after a member edit so the following
  // page-level save cannot serialize a stale dimension definition.
  if (typeof syncDocumentFromUi === "function") data.document = syncDocumentFromUi(data);
}

function syncModelPublicYaml(source, isPublic) {
  const text = String(source || "");
  if (!text.trim()) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const cubesIndex = lines.findIndex((line) => /^\s*cubes\s*:\s*$/.test(line));
  if (cubesIndex < 0) return text;

  const cubeItem = /^([ \t]*)-\s+name\s*:/;
  const cubeIndex = lines.findIndex((line, index) => index > cubesIndex && cubeItem.test(line));
  if (cubeIndex < 0) return text;
  const itemIndent = cubeItem.exec(lines[cubeIndex])?.[1] || "";
  const propertyIndent = `${itemIndent}  `;
  const nextCubeOrRoot = lines.findIndex((line, index) => {
    if (index <= cubeIndex || !line.trim()) return false;
    const indent = line.match(/^[ \t]*/)?.[0] || "";
    return indent.length <= itemIndent.length && !line.trim().startsWith("#");
  });
  const cubeEnd = nextCubeOrRoot < 0 ? lines.length : nextCubeOrRoot;
  const publicPattern = new RegExp(`^${propertyIndent.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}public\\s*:`);
  const publicIndex = lines.findIndex((line, index) => index > cubeIndex && index < cubeEnd && publicPattern.test(line));
  const publicLine = `${propertyIndent}public: ${Boolean(isPublic)}`;
  if (publicIndex >= 0) lines[publicIndex] = publicLine;
  else lines.splice(cubeIndex + 1, 0, publicLine);
  return lines.join(newline);
}

function saveMember(kind, index, item) {
  if (kind === "dimensions") {
    const current = currentModelData()?.dimensions?.[index];
    if (index === null || !current) return toast("维度字段由数据源管理，请先修改数据源后重新建模");
    if (item.name !== current.name || item.sql !== current.sql || item.type !== current.type || item.primary !== current.primary) {
      return toast("字段名称、SQL、类型和主键属性由数据源管理，请先修改数据源后重新建模");
    }
  }
  if (!item.name || !item.title || ("sql" in item && !item.sql)) return toast("请填写必填字段");
  const data = currentModelData();
  const list = data[kind];
  if (index !== null && list[index]) list[index] = { ...list[index], ...item }; else list.push(item);
  syncYamlPreview(data, kind);
  closeModal();

  // Dimension edits are complete at the modal boundary: persist the draft
  // immediately so users do not have to repeat the same save action in the
  // model toolbar.
  if (kind === "dimensions" && typeof saveRealModel === "function" && data.filename) {
    state.modelState = "dirty";
    state.modelStatusHidden = false;
    render();
    void saveRealModel(false);
    return;
  }

  if (kind === "dimensions") {
    state.modelState = "saved";
    state.modelStatusHidden = true;
    currentModel().status = "草稿";
    saveModelSnapshot(currentModel().id);
    render();
    return toast("维度已保存，草稿已自动保存");
  }
  state.modelState = "dirty";
  render();
  toast(`${kind === "dimensions" ? "维度" : kind === "metrics" ? "指标" : "关联"}已加入草稿`);
}

function termModal(index = null) {
  const item = index !== null ? normalizeGlossaryItem(glossary[index]) : [[], "", "指标", "订单分析", ""];
  openModal({ title: index !== null ? "编辑业务术语" : "新增业务术语", sub: "一个标准术语可配置多个别名，并填写业务定义。", icon: "◎", confirm: "保存术语", body: `<div class="grid cols-2"><label class="field">标准术语<input id="termStandard" value="${escapeHtml(item[1])}" placeholder="例如：成交金额" ${index !== null ? "disabled" : ""}></label><label class="field">分类<select id="termType">${["指标", "机构", "系统"].map(type => `<option ${type === item[2] ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field" style="grid-column:1/-1">术语描述<textarea id="termDescription" placeholder="例如：订单实际支付金额的汇总值">${escapeHtml(item[4])}</textarea></label><label class="field" style="grid-column:1/-1">别名<textarea id="termAliases" placeholder="例如：GMV、成交额、交易额">${escapeHtml(termAliases(item).join("\n"))}</textarea><small>每行一个，也可使用中文逗号、英文逗号或顿号分隔；重复别名会自动去除。</small></label><label class="field">关联模型<select id="termModel">${models.map(model => `<option ${model.name === item[3] ? "selected" : ""}>${model.name}</option>`).join("")}</select></label></div>`, onConfirm: () => {
    const aliases = parseTermAliases($("#termAliases").value);
    const standard = $("#termStandard").value.trim();
    if (!aliases.length || !standard) return toast("请填写标准术语和至少一个别名");
    const conflict = glossary.find((entry, entryIndex) => entryIndex !== index && termAliases(entry).some(alias => aliases.includes(alias)));
    if (conflict) return toast(`别名已被“${conflict[1]}”使用`);
    const next = [aliases, standard, $("#termType").value, $("#termModel").value, $("#termDescription").value.trim()];
    if (index !== null) glossary[index] = next; else glossary.push(next);
    closeModal();
    render();
    toast("业务术语已保存");
  } });
}

function validateModel() {
  const returnState = state.modelState;
  setModelState("validating", true);
  setTimeout(() => {
    if (state.page !== "models") return;
    state.modelState = state.modelState === "validating" ? returnState : state.modelState;
    render();
    openModal({ title: "模型校验通过", sub: "已按语法、模型引用和 Cube 加载状态分层检查。", icon: "✓", confirm: "完成", body: '<div class="confirm-list"><div class="confirm-item"><i>✓</i><div><strong>YAML 语法与结构</strong><small>格式正确，未知字段 refresh_key 已安全保留</small></div><em>通过</em></div><div class="confirm-item"><i>✓</i><div><strong>字段与模型引用</strong><small>维度、指标、主键和关联均有效</small></div><em>通过</em></div><div class="confirm-item"><i>✓</i><div><strong>Cube /meta 加载</strong><small>当前已应用版本可被 Cube API 正确识别</small></div><em>通过</em></div></div>' });
  }, 550);
}

function diffModal() {
  openModal({ title: "模型变更对比", sub: "应用前确认可视化表单与 YAML 产生的最终差异。", icon: "±", wide: true, confirm: "关闭", body: '<div class="diff"><div><div class="diff-label">当前已应用版本</div><pre>measures:\n  - name: gmv\n    sql: paid_amount\n    type: sum</pre></div><div><div class="diff-label">待应用草稿</div><pre>measures:\n  - name: gmv\n    sql: paid_amount\n    type: sum\n<span class="plus">    title: 成交金额\n    format: currency</span></pre></div></div><div class="soft-box" style="margin-top:12px"><strong>变更摘要</strong><p class="muted">新增 1 项 · 修改 2 项 · 删除 0 项 · 高级字段无变化</p></div>' });
}

function applyModel() {
  if (!canApplyModels()) {
    return toast(state.modelState === "dirty" ? "请先保存当前模型修改" : "暂无已保存草稿");
  }
  openModal({ title: "应用模型到 Cube", sub: "先保存草稿、执行校验，再重新加载 Cube 模型。", icon: "↻", confirm: "确认应用", body: '<div class="confirm-list"><div class="confirm-item"><i>1</i><div><strong>保存模型文件</strong><small>完整保留未知配置</small></div><em>待执行</em></div><div class="confirm-item"><i>2</i><div><strong>三层校验</strong><small>YAML、引用关系、Cube /meta</small></div><em>待执行</em></div><div class="confirm-item"><i>3</i><div><strong>重新加载 Cube</strong><small>失败时保留原版本</small></div><em>待执行</em></div></div>', onConfirm: () => {
    closeModal();
    state.modelState = "applying";
    render();
    setTimeout(() => {
      const model = currentModel();
      model.status = "已加载";
      model.name = currentModelData().form.title;
      model.source = `${currentModelData().form.source}.${currentModelData().form.table}`;
      model.updated = "刚刚";
      state.modelState = "applied";
      saveModelSnapshot(model.id);
      render();
      toast("模型已应用，Cube 加载正常");
    }, 700);
  } });
}

function genericModal(title, sub = "该操作当前没有可用的服务端接口。") {
  openModal({ title, sub, icon: "◇", confirm: "关闭", body: '<div class="soft-box"><strong>暂不可用</strong><p class="muted" style="line-height:1.7">当前环境未提供此操作所需的真实 API。</p></div>', onConfirm: closeModal });
}

function switchModel(next) {
  if (!modelData[next] || next === state.model) return;
  if (state.modelState === "dirty") {
    return openModal({ title: "切换模型？", sub: "当前模型有未保存的修改。", icon: "!", confirm: "放弃并切换", body: '<div class="soft-box orange"><strong>放弃后，当前模型会恢复到最近一次保存的草稿或已应用版本。</strong><p class="muted" style="margin:7px 0 0">YAML 编辑内容也会一并还原。</p></div>', onConfirm: () => {
      closeModal();
      restoreModelSnapshot(state.model);
      state.model = next;
      state.modelTab = "基础信息";
      state.modelStatusHidden = false;
      state.modelState = modelSavedState(currentModel());
      render();
    } });
  }
  state.model = next;
  state.modelTab = "基础信息";
  state.modelStatusHidden = false;
  state.modelState = modelSavedState(currentModel());
  render();
}

function filterMonitor() {
  const rawSearch = $("#rawLogSearch");
  if (rawSearch) {
    const query = rawSearch.value.trim().toLowerCase();
    $$('[data-log-text]').forEach(row => row.hidden = !row.dataset.logText.includes(query));
  }
  const querySearch = $("#queryLogSearch");
  if (querySearch) {
    const text = querySearch.value.trim().toLowerCase();
    const status = $("#queryLogStatus").value;
    $$('[data-query-text]').forEach(row => row.hidden = !row.dataset.queryText.includes(text) || (status !== "all" && row.dataset.queryStatus !== status));
  }
}

function bindBasePage() {
  $$('[data-action]', $("#pageRoot")).forEach(button => button.onclick = () => handleAction(button.dataset.action, button));
  $$(".model-source-trigger").forEach(trigger => trigger.onkeydown = event => {
    const wrapper = trigger.closest(".model-source-select");
    const menu = wrapper?.querySelector(".model-source-menu");
    const options = wrapper ? $$(".model-source-option", wrapper) : [];
    if (!wrapper || !menu || !options.length) return;
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeModelSourceMenus();
      trigger.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (menu.hidden) {
      handleAction("toggle-model-source", trigger);
      return;
    }
    const activeIndex = options.findIndex(option => option.dataset.active === "true");
    if (event.key === "ArrowDown") return setModelSourceActive(wrapper, activeIndex + 1);
    if (event.key === "ArrowUp") return setModelSourceActive(wrapper, activeIndex - 1);
    if (event.key === "Home") return setModelSourceActive(wrapper, 0);
    if (event.key === "End") return setModelSourceActive(wrapper, options.length - 1);
    if (event.key === "Enter" || event.key === " ") return handleAction("select-model-source", options[Math.max(activeIndex, 0)]);
  });
  $$('[data-model]').forEach(button => button.onclick = () => switchModel(button.dataset.model));
  $$('[data-model-tab]').forEach(button => button.onclick = () => { state.modelTab = button.dataset.modelTab; render(); });
  $$('[data-log-view]').forEach(button => button.onclick = () => { state.monitorLogView = button.dataset.logView; render(); });
  $$('[data-model-field]').forEach(field => field.oninput = () => {
    const key = field.dataset.modelField;
    if (key === "yaml") {
      // 保留编辑器原生撤销栈；input 事件会在 Command/Ctrl+Z 后同步草稿文本。
      currentModelData().yamlDraft = field.value;
      currentModelData().yamlEdited = true;
    } else {
      const data = currentModelData();
      data.form[key] = field.value;
      if (key === "title") currentModel().name = field.value;
      syncYamlPreview(data, "model");
    }
    setModelState("dirty");
    const strip = $(".status-strip");
    if (strip) strip.classList.add("warn");
  });
  const modelSearch = $("#modelSearch");
  if (modelSearch) modelSearch.oninput = event => $$('.model-item').forEach(item => item.hidden = !item.textContent.toLowerCase().includes(event.target.value.toLowerCase()));
  const mobileSelect = $("#mobileModelSelect");
  if (mobileSelect) mobileSelect.onchange = event => switchModel(event.target.value);
  const glossarySearch = $("#glossSearch");
  if (glossarySearch) {
    let composing = false;
    const applyGlossarySearch = () => {
      state.glossaryQuery = glossarySearch.value;
      filterGlossaryRows(state.glossaryQuery);
    };
    glossarySearch.addEventListener("compositionstart", () => { composing = true; });
    glossarySearch.addEventListener("compositionend", () => { composing = false; applyGlossarySearch(); });
    glossarySearch.addEventListener("input", event => {
      if (!composing && !event.isComposing) applyGlossarySearch();
    });
  }
  const rawSearch = $("#rawLogSearch");
  if (rawSearch) rawSearch.oninput = filterMonitor;
  const querySearch = $("#queryLogSearch");
  const queryStatus = $("#queryLogStatus");
  if (querySearch) querySearch.oninput = filterMonitor;
  if (queryStatus) queryStatus.onchange = filterMonitor;
  $$('[data-env-field]').forEach(field => {
    const update = () => {
      environmentConfig[field.dataset.envField] = field.value.trim();
      state.environmentDirty = true;
      const saveButton = $('[data-action="save-environment"]');
      if (saveButton) saveButton.disabled = false;
      const status = field.closest(".card")?.querySelector(".card-head p");
      if (status) status.textContent = "有未保存的修改";
    };
    field.oninput = update;
    field.onchange = update;
  });
  const glossaryImportInput = $("#glossaryImportInput");
  if (glossaryImportInput) glossaryImportInput.onchange = event => {
    if (typeof previewGlossaryImport === "function") previewGlossaryImport(event.target.files?.[0]);
    event.target.value = "";
  };
  $$('.query-row').forEach(row => {
    const open = event => {
      if (event.target.closest("button")) return;
      if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
      if (event.type === "keydown") event.preventDefault();
      handleAction(queryRecords[Number(row.dataset.queryIndex)].action, row);
    };
    row.onclick = open;
    row.onkeydown = open;
  });
}

function handleUiAction(action, element) {
  const index = element?.dataset.index !== undefined ? Number(element.dataset.index) : null;
  if (action === "toggle-model-source") {
    const wrapper = element.closest(".model-source-select");
    const menu = wrapper?.querySelector(".model-source-menu");
    if (!menu) return;
    const opened = menu.hidden;
    closeModelSourceMenus(wrapper);
    menu.hidden = !opened;
    element.setAttribute("aria-expanded", String(opened));
    if (opened) {
      const selectedIndex = $$(".model-source-option", wrapper).findIndex(option => option.getAttribute("aria-selected") === "true");
      setModelSourceActive(wrapper, selectedIndex);
    }
    return;
  }
  if (action === "select-model-source") {
    const wrapper = element.closest(".model-source-select");
    const input = wrapper?.querySelector('[data-model-field="source"]');
    const trigger = wrapper?.querySelector(".model-source-trigger");
    if (!wrapper || !input || !trigger) return;
    const value = element.dataset.value || "";
    const label = element.dataset.label || "不绑定数据源";
    input.value = value;
    currentModelData().form.source = value;
    wrapper.querySelector("[data-model-source-label]").textContent = label;
    wrapper.querySelectorAll(".model-source-option").forEach(option => {
      option.setAttribute("aria-selected", String(option === element));
      option.firstChild.textContent = option === element ? "✓" : "";
      delete option.dataset.active;
    });
    trigger.removeAttribute("aria-activedescendant");
    closeModelSourceMenus();
    syncYamlPreview(currentModelData(), "model");
    setModelState("dirty");
    return;
  }
  if (action === "toggle-model-more") {
    const wrapper = element.closest(".model-more");
    const menu = wrapper?.querySelector(".model-more-menu");
    if (!menu) return;
    const opened = menu.classList.contains("hidden");
    closeModelMoreMenus(wrapper);
    menu.classList.toggle("hidden", !opened);
    element.setAttribute("aria-expanded", String(opened));
    return;
  }
  if (action === "new-source") return sourceModal();
  if (action === "edit-source") return sourceModal(index);
  if (action === "test-source") {
    const source = dataSources[index];
    if (!source) return;
    source.checked = "刚刚 · 18 ms";
    source.status = "正常";
    render();
    return toast("连接测试通过，延迟 18 ms");
  }
  if (action === "delete-source") {
    const source = dataSources[index];
    if (!source) return;
    return openModal({
      title: `删除数据源“${source.name}”？`,
      sub: "删除会进入待应用状态，正式应用后才影响 Cube。",
      icon: "!",
      confirm: "确认删除",
      body: `<div class="soft-box red"><strong>影响范围</strong><p class="muted" style="margin:7px 0 0;line-height:1.7">该数据源当前关联 ${source.models} 个模型。删除后，这些模型将无法查询，需改绑其他数据源后再应用。</p></div><label class="field" style="margin-top:14px">输入数据源名称“${escapeHtml(source.name)}”确认<input id="deleteSourceConfirm" autocomplete="off"></label>`,
      onConfirm: () => {
        dataSources.splice(index, 1);
        closeModal();
        render();
        toast("数据源已从待应用配置中删除");
      },
      afterOpen: () => {
        const confirm = $("#modalConfirm");
        const input = $("#deleteSourceConfirm");
        confirm.disabled = true;
        input.oninput = () => confirm.disabled = input.value.trim() !== source.name;
        input.focus();
      }
    });
  }
  if (action === "new-model") return newModelModal();
  if (action === "auto-model") return genericModal("自动建模", "选择物理表后，系统将推断主键、时间维度和基础指标并生成草稿。");
  if (action === "delete-model") {
    if (models.length === 1) return toast("至少保留一个语义模型");
    const model = currentModel();
    const data = currentModelData();
    return openModal({
      title: `删除语义模型“${model.name}”？`,
      sub: "这是高风险操作，删除后下游查询和术语引用可能失效。",
      icon: "!",
      confirm: "确认删除",
      body: `<div class="soft-box red"><strong>将删除完整模型配置</strong><p class="muted" style="margin:7px 0 0;line-height:1.7">包括 ${data.dimensions.length} 个维度、${data.metrics.length} 个指标和 ${data.joins.length} 条关联。正式系统还会检查下游查询与术语引用。</p></div><label class="field" style="margin-top:14px">输入模型名称“${escapeHtml(model.id)}”确认<input id="deleteModelConfirm" autocomplete="off"></label>`,
      onConfirm: () => {
        const deletingIndex = models.findIndex(item => item.id === model.id);
        models.splice(deletingIndex, 1);
        delete modelData[model.id];
        delete modelSnapshots[model.id];
        const next = models[Math.min(deletingIndex, models.length - 1)];
        state.model = next.id;
        state.modelTab = "基础信息";
        state.modelState = next.pending || next.status === "草稿" ? "saved" : "applied";
        closeModal();
        render();
        toast("语义模型已删除");
      },
      afterOpen: () => {
        const confirm = $("#modalConfirm");
        const input = $("#deleteModelConfirm");
        confirm.disabled = true;
        input.oninput = () => confirm.disabled = input.value.trim() !== model.id;
        input.focus();
      }
    });
  }
  if (action === "new-dimension") return memberModal("dimensions");
  if (action === "edit-dimension") return memberModal("dimensions", index);
  if (action === "new-metric") return memberModal("metrics");
  if (action === "edit-metric") return memberModal("metrics", index);
  if (action === "new-join") return memberModal("joins");
  if (action === "edit-join") return memberModal("joins", index);
  if (action === "delete-member") {
    const kind = element.dataset.kind;
    if (kind === "dimensions") return toast("维度字段由数据源管理，不能在此删除；请修改数据源后重新建模");
    const item = currentModelData()[kind][index];
    return openModal({ title: `删除“${item.title}”？`, sub: "删除会进入当前草稿，应用前仍可查看差异。", icon: "!", confirm: "确认删除", body: '<div class="soft-box red"><strong>系统会检查引用关系，避免删除仍被使用的成员。</strong></div>', onConfirm: () => { const data = currentModelData(); data[kind].splice(index, 1); syncYamlPreview(data, kind); closeModal(); state.modelState = "dirty"; render(); toast("已从草稿中删除"); } });
  }
  if (action === "toggle-public") {
    const data = currentModelData();
    data.form.public = !data.form.public;
    syncYamlPreview(data, "model");
    state.modelState = "saved";
    state.modelStatusHidden = false;
    currentModel().status = "草稿";
    saveModelSnapshot(currentModel().id);
    return render();
  }
  if (action === "toggle-member-public") {
    const kind = element.dataset.kind;
    const memberTableScroll = captureMemberTableScroll(element);
    const data = currentModelData();
    const item = data[kind]?.[Number(element.dataset.index)];
    if (!item) return;
    item.public = item.public === false;
    syncYamlPreview(data, kind);
    element.classList.toggle("on", item.public);
    element.setAttribute("aria-pressed", String(item.public));
    element.setAttribute("title", item.public ? "关闭对外暴露" : "开启对外暴露");
    state.modelState = "saved";
    state.modelStatusHidden = false;
    currentModel().status = "草稿";
    saveModelSnapshot(currentModel().id);
    render();
    restoreMemberTableScroll(memberTableScroll);
    return;
  }
  if (action === "save-draft") {
    if (state.modelState !== "dirty") return toast("当前没有待保存的修改");
    state.modelState = "saved";
    state.modelStatusHidden = false;
    currentModel().status = "草稿";
    saveModelSnapshot(currentModel().id);
    render();
    return toast("模型草稿已保存，尚未应用到 Cube");
  }
  if (action === "discard-model") {
    restoreModelSnapshot(state.model);
    state.modelStatusHidden = true;
    state.modelState = modelSavedState(currentModel());
    render();
    return toast("已放弃修改，恢复到最近保存版本");
  }
  if (action === "apply-models") return applyModel();
  if (action === "apply-model") return applyModel();
  if (action === "show-diff") return diffModal();
  if (action === "validate-model") return validateModel();
  if (action === "test-query") return openQueryDrawer();
  if (action === "format-yaml") return toast("YAML 已格式化，未知字段保持不变");
  if (action === "validate-yaml") return toast("YAML 语法与结构检查通过");
  if (action === "new-term") return termModal();
  if (action === "edit-term") return termModal(index);
  if (action === "toggle-offline") {
    environmentConfig.offlineMode = !environmentConfig.offlineMode;
    state.environmentDirty = true;
    render();
    return;
  }
  if (action === "test-environment") {
    if (!environmentConfig.consoleDomain || !environmentConfig.cubeApiUrl || !environmentConfig.deployPath) return toast("请先填写完整环境配置");
    return toast("域名、Cube API 和部署目录检查通过");
  }
  if (action === "save-environment") {
    if (!/^[a-z0-9.-]+$/i.test(environmentConfig.consoleDomain)) return toast("配置台域名格式不正确");
    if (!/^https?:\/\//i.test(environmentConfig.cubeApiUrl)) return toast("Cube API 地址需以 http:// 或 https:// 开头");
    if (!environmentConfig.deployPath.startsWith("/opt/")) return toast("部署根目录建议填写 /opt 下的绝对路径");
    state.environmentDirty = false;
    render();
    return toast("环境配置已保存");
  }
  if (["refresh", "refresh-monitor"].includes(action)) return toast("数据已刷新");
  if (action === "copy-endpoint") return copyText(element.closest("tr")?.querySelector(".mono")?.textContent || "", "端点地址已复制");
  if (action === "copy-spec-url") return copyText("http://127.0.0.1:28081/openapi.yaml", "Spec URL 已复制");
  if (action === "download-openapi") return toast("openapi.yaml 已准备下载");
  if (action === "download-logs") return toast("日志文件已准备下载");
  if (action === "generate-token") { $("#generatedToken")?.classList.remove("hidden"); return toast("令牌已生成，请及时复制保存"); }
  if (action === "query-record-detail") return openModal({ title: "查询详情", sub: "Trace ID：req_8f42c1 · 订单分析", icon: "Q", wide: true, confirm: "关闭", body: '<div class="query-summary"><div><strong>查询成功 · 186 ms</strong><span class="muted">　12:42:31</span></div><span class="cache-pill">⚡ 预聚合</span></div><div class="grid cols-2"><pre class="code-panel">{\n  "measures": ["orders.order_count", "orders.gmv"],\n  "dimensions": ["orders.status"]\n}</pre><pre class="code-panel">SELECT status, COUNT(*), SUM(paid_amount)\nFROM ecommerce.orders\nGROUP BY status</pre></div>' });
  if (action === "query-record-error") return openModal({ title: "查询失败", sub: "Trace ID：req_19b7d2 · 流量分析", icon: "!", wide: true, confirm: "关闭", body: '<div class="soft-box red"><strong>成员引用不存在</strong><p class="muted">traffic.page_url 未在当前已加载模型中找到。请检查 traffic.yml 第 24 行。</p></div><pre class="code-panel" style="min-height:140px">UserError: Member traffic.page_url not found</pre>' });
  return genericModal(element?.textContent.trim() || "操作详情");
}

$("#mainNav").onclick = event => {
  const button = event.target.closest('[data-page]');
  if (button) gotoPage(button.dataset.page);
};
$("#modalClose").onclick = $("#modalCancel").onclick = closeModal;
// 遮罩层只负责阻止背景交互，不再承担关闭弹窗的职责，避免误触导致表单内容丢失。
$("#overlay").onclick = event => { event.stopPropagation(); };
$("#drawerClose").onclick = closeQueryDrawer;
$("#drawerBackdrop").onclick = event => { event.stopPropagation(); };
document.addEventListener("keydown", event => {
  if ($("#overlay").classList.contains("show")) {
    if (event.key === "Escape") closeModal(); else trapFocus($("#modal"), event);
    return;
  }
  if ($("#queryDrawer").classList.contains("show")) {
    if (event.key === "Escape") closeQueryDrawer(); else trapFocus($("#queryDrawer"), event);
  }
});

function closeModelMoreMenus(except = null) {
  $$(".model-more").forEach(wrapper => {
    if (wrapper === except) return;
    wrapper.querySelector(".model-more-menu")?.classList.add("hidden");
    wrapper.querySelector('[data-action="toggle-model-more"]')?.setAttribute("aria-expanded", "false");
  });
}

function closeModelSourceMenus(except = null) {
  $$(".model-source-select").forEach(wrapper => {
    if (wrapper === except) return;
    wrapper.querySelector(".model-source-menu")?.setAttribute("hidden", "");
    wrapper.querySelector(".model-source-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function setModelSourceActive(wrapper, index) {
  const options = $$(".model-source-option", wrapper);
  if (!options.length) return;
  const nextIndex = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => option.dataset.active = String(optionIndex === nextIndex));
  wrapper.querySelector(".model-source-trigger")?.setAttribute("aria-activedescendant", options[nextIndex].id || "");
}

document.addEventListener("click", event => {
  const wrapper = event.target?.closest?.(".model-more");
  if (wrapper) {
    if (event.target.closest?.(".model-more-menu")) closeModelMoreMenus();
    closeModelSourceMenus();
    return;
  }
  closeModelMoreMenus();
  if (!event.target?.closest?.(".model-source-select")) closeModelSourceMenus();
});

/* Cube 配置台唯一运行时：所有核心读写均通过受保护的真实 API。 */
const REAL_TOKEN_KEY = "cube_console_admin_token";
const REAL_JWT_TOKENS_KEY = "cube_console_generated_jwts";
const runtime = { status: null, info: null, query: null, queryError: "", loaded: false, jwtTokens: [], lastGeneratedToken: null, openapiSchemas: {}, mcpServers: [], availableMcpModels: [] };

function compactRealError(error, fallback = "操作失败") {
  const text = String(error?.message || fallback).replace(/\s+/g, " ").trim();
  const first = text.split(";")[0].trim();
  return first.length > 220 ? `${first.slice(0, 220)}…` : first;
}

function checkCommonYamlMistakes(content) {
  const firstLine = String(content || "").split(/\r?\n/, 1)[0].trim();
  if (/^cubes:\s*\d+\s*$/.test(firstLine)) {
    throw new Error("第 1 行格式错误：应为“cubes:”，不能写成“cubes:1”；可点击“放弃修改”恢复服务器版本");
  }
}

async function realApi(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = localStorage.getItem(REAL_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    showRealLogin("管理员令牌已失效，请重新登录");
    throw new Error("未授权");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function localJwtTokens() {
  try {
    const value = JSON.parse(localStorage.getItem(REAL_JWT_TOKENS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}

function saveLocalJwtToken(record, token) {
  if (!record?.id || !token) return;
  const next = [{ id: record.id, token }, ...localJwtTokens().filter((item) => item.id !== record.id)].slice(0, 100);
  localStorage.setItem(REAL_JWT_TOKENS_KEY, JSON.stringify(next));
}

function localJwtToken(id) {
  return localJwtTokens().find((item) => item.id === id)?.token || "";
}

function runtimeJwtToken(id) {
  return (runtime.jwtTokens || []).find((item) => item.id === id)?.token || localJwtToken(id);
}

function openApiSchemaLabel(schema) {
  if (!schema || typeof schema !== "object") return "—";
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.type === "array") return `array<${openApiSchemaLabel(schema.items)}>`;
  if (schema.enum) return `${schema.type || "string"} · ${schema.enum.join(" / ")}`;
  return schema.type || (schema.oneOf ? "oneOf" : schema.anyOf ? "anyOf" : "object");
}

function cubeApiBaseUrl() {
  return String(runtime.info?.cube?.base || window.location.origin).replace(/\/+$/, "");
}

function toolEndpointUrl(tool) {
  const path = String(tool?.path || "");
  return `${cubeApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function toolCurlCommand(tool) {
  const method = String(tool?.method || "GET").toUpperCase();
  const lines = [
    `curl --request ${method} '${toolEndpointUrl(tool)}'`,
    "  --header 'Authorization: Bearer <YOUR_JWT>'",
  ];
  if (tool?.requestBody) {
    lines.push("  --header 'Content-Type: application/json'", "  --data '{}'");
  }
  return lines.join(" \\\n");
}

function renderOpenApiDetails(tool) {
  const parameters = Array.isArray(tool.parameters) ? tool.parameters : [];
  const body = tool.requestBody;
  const responses = tool.responses && typeof tool.responses === "object" ? tool.responses : {};
  const parameterHtml = parameters.length ? parameters.map((parameter) => {
    if (parameter?.$ref) return `<div class="openapi-param"><strong>${escapeHtml(parameter.$ref)}</strong></div>`;
    return `<div class="openapi-param"><div class="openapi-param-head"><strong>${escapeHtml(parameter.name || "未命名参数")}</strong><span class="badge purple">${escapeHtml(parameter.in || "parameter")}</span>${parameter.required ? '<span class="badge orange">必填</span>' : '<span class="badge">可选</span>'}</div><div class="openapi-param-meta">${escapeHtml(openApiSchemaLabel(parameter.schema))}</div><p>${escapeHtml(parameter.description || "暂无参数说明")}</p>${parameter.example !== undefined ? `<code>示例：${escapeHtml(String(parameter.example))}</code>` : ""}</div>`;
  }).join("") : '<div class="muted">无显式路径、查询或请求头参数</div>';
  let requestHtml = '<div class="muted">无请求体</div>';
  if (body) {
    const content = body.content && typeof body.content === "object" ? body.content : {};
    requestHtml = `<div class="openapi-request"><div><strong>请求体</strong>${body.required ? '<span class="badge orange">必填</span>' : '<span class="badge">可选</span>'}${body.description ? `<p>${escapeHtml(body.description)}</p>` : ""}</div>${Object.entries(content).map(([type, media]) => `<div class="openapi-content"><strong>${escapeHtml(type)}</strong><span class="muted">${escapeHtml(openApiSchemaLabel(media?.schema))}</span>${media?.schema ? `<pre>${escapeHtml(JSON.stringify(media.schema, null, 2))}</pre>` : ""}</div>`).join("")}</div>`;
  }
  const responseHtml = Object.entries(responses).map(([status, response]) => `<div class="openapi-response"><strong>${escapeHtml(status)}</strong><span>${escapeHtml(response?.description || "无响应说明")}</span></div>`).join("") || '<div class="muted">暂无响应定义</div>';
  return `<details class="openapi-details"><summary>查看完整参数与接口定义 <span class="muted">${parameters.length} 个参数${body ? " · 含请求体" : ""}</span></summary><div class="openapi-detail-grid"><div><h4>参数</h4>${parameterHtml}</div><div><h4>请求体</h4>${requestHtml}<h4>响应</h4>${responseHtml}</div></div>${tool.description ? `<div class="openapi-description"><h4>详细说明</h4><p>${escapeHtml(tool.description)}</p></div>` : ""}</details>`;
}

function tokenStatusLabel(status) { return status === "active" ? "有效" : "已过期"; }
function tokenDate(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
function tokenDisplayKey(record) {
  const fingerprint = String(record?.fingerprint || record?.prefix || record?.id || "").replace(/[^a-zA-Z0-9]/g, "");
  return `app...${fingerprint.slice(-12) || "未识别密钥"}`;
}
function renderTokenRows() {
  const local = localJwtTokens();
  const rows = (runtime.jwtTokens || []).map((record) => {
    const available = Boolean(record.token || local.some((item) => item.id === record.id));
    return `<div class="simple-token-row" role="row"><div class="simple-token-cell simple-token-key"><strong title="${escapeHtml(record.prefix || "JWT …")}">${escapeHtml(tokenDisplayKey(record))}</strong>${record.purpose && record.purpose !== "service-account" ? `<small>${escapeHtml(record.purpose)}</small>` : ""}</div><div class="simple-token-cell">${escapeHtml(tokenDate(record.createdAt))}</div><div class="simple-token-cell">${record.lastUsedAt ? escapeHtml(tokenDate(record.lastUsedAt)) : "从未"}</div><div class="simple-token-actions"><button class="simple-token-icon" data-action="copy-jwt-token" data-token-id="${escapeHtml(record.id)}" title="${available ? "复制完整密钥" : "该记录没有完整密钥，请重新生成"}" aria-label="复制密钥"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M5 16V5.5A1.5 1.5 0 0 1 6.5 4H16"/></svg></button><button class="simple-token-icon danger" data-action="delete-jwt-token" data-token-id="${escapeHtml(record.id)}" title="删除密钥" aria-label="删除密钥"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l.8 13h8.4L17 7M10 11v5M14 11v5"/></svg></button></div></div>`;
  }).join("");
  return rows ? `<div class="simple-token-table" role="table"><div class="simple-token-row simple-token-head" role="row"><span>服务访问密钥</span><span>创建时间</span><span>最后使用</span><span aria-label="操作"></span></div>${rows}</div>` : '<div class="empty compact"><b>暂无服务访问密钥</b><span>点击“创建密钥”生成第一个密钥。</span></div>';
}

function openTokenCreateModal() {
  openModal({
    title: "创建密钥",
    sub: "创建后请立即复制，关闭窗口后将无法再次查看完整内容。",
    icon: "J",
    confirm: "创建密钥",
    body: '<label class="field">密钥备注（可选）<input id="tokenKeyLabel" maxlength="80" placeholder="例如：报表服务"></label><p class="muted" style="margin:8px 0 0;font-size:11px">备注只用于在列表中识别密钥，不会影响权限。</p>',
    onConfirm: async () => {
      const button = $("#modalConfirm");
      const purpose = String($("#tokenKeyLabel")?.value || "service-account").trim().slice(0, 80) || "service-account";
      button.disabled = true;
      button.textContent = "创建中…";
      try {
        const result = await realApi("/api/jwt", { method: "POST", body: JSON.stringify({ days: 30, purpose }) });
        // The API intentionally returns only token metadata when listing records.
        // Keep the full value locally while it is still available from creation so
        // the copy action continues to work after the modal is closed or refreshed.
        saveLocalJwtToken(result.record, result.token);
        runtime.lastGeneratedToken = { id: result.record?.id || "", token: result.token, record: result.record || {} };
        runtime.jwtTokens = [result.record, ...(runtime.jwtTokens || []).filter((item) => item.id !== result.record?.id)].filter(Boolean);
        $("#modalTitle").textContent = "密钥已创建";
        $("#modalSub").textContent = "请立即复制完整密钥，关闭窗口后将无法再次查看。";
        $("#modalBody").innerHTML = `<div class="token-created-note"><strong>密钥已生成</strong><span>仅本次展示完整内容，请妥善保存。</span></div><div class="token-created-value"><code>${escapeHtml(result.token)}</code><button class="btn small" id="copyCreatedToken" type="button">复制</button></div>`;
        $("#modalConfirm").disabled = false;
        $("#modalConfirm").textContent = "我已复制，关闭";
        $("#modalConfirm").onclick = () => { closeModal(); render(); };
        $("#copyCreatedToken").onclick = () => copyText(result.token, "密钥已复制");
        render();
      } catch (error) {
        button.disabled = false;
        button.textContent = "创建密钥";
        toast(`创建密钥失败：${compactRealError(error)}`);
      }
    },
  });
}

function mcpServerModal(server = null) {
  const editing = Boolean(server);
  const selectedIds = new Set(server?.modelIds || []);
  const availableSelection = new Set();
  const selectedSelection = new Set();
  const names = new Map(models.map((model) => [model.id, model.name]));
  const allIds = runtime.availableMcpModels || [];
  const modelSource = (id) => {
    const model = models.find((item) => item.id === id);
    return modelData[id]?.form?.source || String(model?.source || "default").split(".")[0] || "default";
  };
  const renderTransfer = () => {
    const renderItems = (ids, side, selection) => {
      if (!ids.length) return `<div class="empty compact"><b>${side === "available" ? "没有可选模型" : "尚未选择模型"}</b></div>`;
      const groups = new Map();
      ids.forEach((id) => { const source = modelSource(id); groups.set(source, [...(groups.get(source) || []), id]); });
      return [...groups.entries()].map(([source, groupIds]) => `<div class="transfer-group"><div class="transfer-group-title">数据源 · ${escapeHtml(source)}</div>${groupIds.map((id) => `<button class="transfer-item ${selection.has(id) ? "selected" : ""}" type="button" data-transfer-side="${side}" data-model-id="${escapeHtml(id)}"><span class="transfer-check"></span><strong>${escapeHtml(names.get(id) || id)}</strong><small class="mono">${escapeHtml(id)}</small></button>`).join("")}</div>`).join("");
    };
    const available = allIds.filter((id) => !selectedIds.has(id));
    const chosen = allIds.filter((id) => selectedIds.has(id));
    const left = $("#mcpTransferAvailable"); const right = $("#mcpTransferSelected");
    if (left) left.innerHTML = renderItems(available, "available", availableSelection);
    if (right) right.innerHTML = renderItems(chosen, "selected", selectedSelection);
    const leftCount = $("#mcpTransferAvailableCount"); const rightCount = $("#mcpTransferSelectedCount");
    if (leftCount) leftCount.textContent = `${available.length} 个`;
    if (rightCount) rightCount.textContent = `${chosen.length} 个`;
    $$('[data-transfer-side="available"]').forEach((button) => button.onclick = () => { const id = button.dataset.modelId; availableSelection.has(id) ? availableSelection.delete(id) : availableSelection.add(id); renderTransfer(); });
    $$('[data-transfer-side="selected"]').forEach((button) => button.onclick = () => { const id = button.dataset.modelId; selectedSelection.has(id) ? selectedSelection.delete(id) : selectedSelection.add(id); renderTransfer(); });
  };
  openModal({
    title: editing ? "编辑 MCP Server" : "创建 MCP Server",
    sub: "每个 Server 只能访问此处选定的语义模型。",
    icon: "⌘",
    wide: true,
    confirm: editing ? "保存修改" : "创建 MCP Server",
    body: `<div class="grid cols-2"><label class="field">名称<input id="mcpServerName" maxlength="80" value="${escapeHtml(server?.name || "")}" placeholder="例如：销售分析 MCP"></label><label class="field">Server ID<input id="mcpServerId" maxlength="63" value="${escapeHtml(server?.id || "")}" placeholder="例如：sales-agent" ${editing ? "readonly" : ""}><small>用于生成 MCP Endpoint，创建后不可修改。</small></label><label class="field" style="grid-column:1/-1">说明（instructions）<textarea id="mcpServerInstructions" maxlength="2000" placeholder="例如：仅用于销售分析，先调用 cube_meta 获取可用模型。">${escapeHtml(server?.instructions || "")}</textarea><small>作为 MCP instructions 提供给 AI；实际访问权限仍由绑定语义模型控制。</small></label></div><div class="field" style="margin-top:18px"><span>绑定语义模型</span><div class="transfer-box"><section class="transfer-pane"><div class="transfer-pane-head"><strong>可选语义模型</strong><span id="mcpTransferAvailableCount"></span></div><div class="transfer-list" id="mcpTransferAvailable"></div></section><div class="transfer-actions"><button id="mcpTransferAdd" type="button" title="添加所选模型">→</button><button id="mcpTransferRemove" type="button" title="移除所选模型">←</button></div><section class="transfer-pane"><div class="transfer-pane-head"><strong>已绑定语义模型</strong><span id="mcpTransferSelectedCount"></span></div><div class="transfer-list" id="mcpTransferSelected"></div></section></div></div>`,
    afterOpen: () => {
      renderTransfer();
      $("#mcpTransferAdd").onclick = () => { availableSelection.forEach((id) => selectedIds.add(id)); availableSelection.clear(); renderTransfer(); };
      $("#mcpTransferRemove").onclick = () => { selectedSelection.forEach((id) => selectedIds.delete(id)); selectedSelection.clear(); renderTransfer(); };
    },
    onConfirm: async () => {
      const modelIds = [...selectedIds];
      const payload = { name: $("#mcpServerName").value.trim(), id: $("#mcpServerId").value.trim(), instructions: $("#mcpServerInstructions").value.trim(), modelIds };
      if (!payload.name || !payload.id || !modelIds.length) return toast("请填写名称、Server ID，并至少绑定一个语义模型");
      setModalBusy();
      try {
        const result = await realApi(editing ? `/api/mcp-servers/${encodeURIComponent(server.id)}` : "/api/mcp-servers", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
        state.mcpServer = result.server.id;
        closeModal();
        await loadRealData();
        toast(editing ? "MCP Server 已更新" : "MCP Server 已创建");
      } catch (error) { restoreModalActions(editing ? "保存修改" : "创建 MCP Server"); toast(compactRealError(error)); }
    },
  });
}

function openMcpTokenCreateModal(serverId) {
  openModal({
    title: "创建服务密钥", sub: "密钥仅能访问当前 MCP Server，请立即复制保存。", icon: "J", confirm: "创建密钥",
    body: '<label class="field">密钥备注（可选）<input id="mcpTokenLabel" maxlength="80" placeholder="例如：销售助手"></label>',
    onConfirm: async () => {
      const button = $("#modalConfirm"); button.disabled = true; button.textContent = "创建中…";
      try {
        const purpose = String($("#mcpTokenLabel")?.value || "service-account").trim() || "service-account";
        const result = await realApi(`/api/mcp-servers/${encodeURIComponent(serverId)}/tokens`, { method: "POST", body: JSON.stringify({ days: 30, purpose }) });
        saveLocalJwtToken(result.record, result.token);
        runtime.lastGeneratedToken = { id: result.record?.id || "", token: result.token, record: result.record || {} };
        runtime.jwtTokens = [result.record, ...(runtime.jwtTokens || []).filter((item) => item.id !== result.record?.id)];
        $("#modalTitle").textContent = "密钥已创建";
        $("#modalSub").textContent = "请立即复制完整密钥，关闭窗口后将无法再次查看。";
        $("#modalBody").innerHTML = `<div class="token-created-note"><strong>密钥已生成</strong><span>该密钥仅适用于当前 MCP Server。</span></div><div class="token-created-value"><code>${escapeHtml(result.token)}</code><button class="btn small" id="copyCreatedToken" type="button">复制</button></div>`;
        $("#modalConfirm").disabled = false; $("#modalConfirm").textContent = "我已复制，关闭"; $("#modalConfirm").onclick = () => { closeModal(); render(); };
        $("#copyCreatedToken").onclick = () => copyText(result.token, "密钥已复制"); render();
      } catch (error) { button.disabled = false; button.textContent = "创建密钥"; toast(`创建密钥失败：${compactRealError(error)}`); }
    },
  });
}

function showRealLogin(message = "请输入管理员令牌访问受保护的管理接口") {
  $("#loginScreen")?.classList.add("show");
  const tip = $("#loginTip");
  if (tip) tip.textContent = message;
}

function typeLabel(type) {
  const value = String(type || "mysql").toLowerCase();
  return value.includes("clickhouse") ? "ClickHouse" : value.includes("postgres") ? "PostgreSQL" : "MySQL";
}

function cubeNameKey(value) {
  return String(value || "").trim().replace(/\.ya?ml$/i, "");
}

function uiModelFromDocument(file, payload, loadedNames) {
  const document = payload.document || { cubes: [] };
  const cube = (document.cubes || [])[0] || {};
  const id = cube.name || file.name.replace(/\.ya?ml$/i, "");
  const sourceName = cube.data_source || (dataSources.some((item) => item.name === "default") ? "default" : "");
  const table = cube.sql_table || "";
  const dimensions = (cube.dimensions || []).map((item) => ({
    title: item.title || item.name || "未命名维度", name: item.name || "", sql: String(item.sql ?? ""),
    type: item.type || "string", primary: !!item.primary_key, public: item.public !== false, description: item.description || "", _raw: item,
  }));
  const metrics = (cube.measures || []).map((item) => ({
    title: item.title || item.name || "未命名指标", name: item.name || "", type: item.type || "number",
    sql: item.sql === undefined ? "—" : String(item.sql), format: typeof item.format === "string" ? item.format : "默认",
    public: item.public !== false, description: item.description || "", _raw: item,
  }));
  const joins = (cube.joins || []).map((item) => {
    const sql = String(item.sql || "");
    const match = sql.match(/\{CUBE\}\.([^\s=]+)\s*=\s*\{[^}]+\}\.([^\s]+)/);
    return { title: item.title || item.name || "关联模型", name: item.name || "", relationship: item.relationship || "many_to_one", source: match?.[1] || "", target: match?.[2] || "", _raw: item };
  });
  modelData[id] = {
    form: { id, title: cube.title || id, source: sourceName, table, description: cube.description || "", sqlSource: table ? "物理表 sql_table" : "自定义 SQL（高级）", public: cube.public !== false },
    dimensions, metrics, joins, yaml: payload.content || "", document, filename: file.name,
  };
  const pending = file.pending === true;
  const loadedSet = new Set((Array.isArray(loadedNames) ? loadedNames : []).map(cubeNameKey));
  const loaded = loadedSet.has(cubeNameKey(id)) || loadedSet.has(cubeNameKey(file.name));
  const source = table && sourceName && table.startsWith(`${sourceName}.`) ? table : `${sourceName}.${table || "自定义 SQL"}`;
  return { id, name: cube.title || id, source, status: pending ? "草稿" : loaded ? "已加载" : "草稿", pending, loaded, updated: new Date(file.mtime).toLocaleString("zh-CN", { hour12: false }) };
}

function syncDocumentFromUi(data) {
  // Work from a detached snapshot. The parsed document is also used as the
  // last server-side baseline; mutating it in place makes a failed save look
  // like it succeeded and can cause later saves to serialize stale members.
  const document = data.document && typeof data.document === "object"
    ? JSON.parse(JSON.stringify(data.document))
    : { cubes: [{}] };
  if (!Array.isArray(document.cubes) || !document.cubes.length) document.cubes = [{}];
  const cube = document.cubes[0];
  cube.name = data.form.id;
  cube.title = data.form.title;
  cube.description = data.form.description;
  cube.sql_table = data.form.table;
  if (data.form.source && data.form.source !== "default") cube.data_source = data.form.source;
  else delete cube.data_source;
  cube.public = !!data.form.public;
  const memberDocument = (item, kind) => {
    const next = { ...(item._raw || {}), name: item.name };
    if (item.title) next.title = item.title; else delete next.title;
    if (kind === "dimensions") {
      next.sql = item.sql;
      next.type = item.type;
      if (item.primary) next.primary_key = true; else delete next.primary_key;
    } else if (item.sql && item.sql !== "—") next.sql = item.sql;
    else delete next.sql;
    if (item.public === false) next.public = false; else delete next.public;
    if (item.description) next.description = item.description; else delete next.description;
    return next;
  };
  cube.dimensions = data.dimensions.map((item) => memberDocument(item, "dimensions"));
  cube.measures = data.metrics.map((item) => memberDocument(item, "metrics"));
  cube.joins = data.joins.map((item) => ({ ...item._raw, name: item.name, relationship: item.relationship, sql: `{CUBE}.${item.source} = {${item.name}}.${item.target}` }));
  return document;
}

function yamlPreviewScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "null";
  return JSON.stringify(String(value));
}

function syncStructuredYamlPreview(data, kind) {
  const sectionMap = { dimensions: "dimensions", metrics: "measures", joins: "joins" };
  const section = sectionMap[kind];
  const source = String(data?.yaml || "");
  if (!section || !source.trim()) return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^(\\s*)${section}\\s*:\\s*$`).test(line));
  if (start < 0) return source;
  const indent = lines[start].match(/^\s*/)?.[0] || "";
  let end = start + 1;
  const sibling = new RegExp(`^${indent}\\S`);
  while (end < lines.length && !sibling.test(lines[end])) end += 1;
  const items = Array.isArray(data[kind]) ? data[kind] : [];
  const replacement = [`${indent}${section}:`];
  if (!items.length) {
    replacement.push(`${indent}  []`);
  } else {
    const known = kind === "dimensions"
      ? new Set(["name", "title", "sql", "type", "primary_key", "primary", "public", "description"])
      : kind === "metrics"
        ? new Set(["name", "title", "sql", "type", "format", "public", "description"])
        : new Set(["name", "title", "relationship", "sql", "source", "target"]);
    items.forEach((item) => {
      replacement.push(`${indent}  - name: ${yamlPreviewScalar(item.name)}`);
      if (item.title) replacement.push(`${indent}    title: ${yamlPreviewScalar(item.title)}`);
      if (kind === "joins") {
        replacement.push(`${indent}    relationship: ${yamlPreviewScalar(item.relationship)}`);
        replacement.push(`${indent}    sql: ${yamlPreviewScalar(`{CUBE}.${item.source} = {${item.name}}.${item.target}`)}`);
      } else {
        if (item.sql && item.sql !== "—") replacement.push(`${indent}    sql: ${yamlPreviewScalar(item.sql)}`);
        if (item.type) replacement.push(`${indent}    type: ${yamlPreviewScalar(item.type)}`);
        if (kind === "dimensions" && item.primary) replacement.push(`${indent}    primary_key: true`);
        if (item.public === false) replacement.push(`${indent}    public: false`);
        if (item.description) replacement.push(`${indent}    description: ${yamlPreviewScalar(item.description)}`);
      }
      Object.entries(item._raw || {}).forEach(([key, value]) => {
        if (known.has(key) || value === undefined || value === null) return;
        replacement.push(`${indent}    ${key}: ${yamlPreviewScalar(value)}`);
      });
    });
  }
  return lines.slice(0, start).concat(replacement, lines.slice(end)).join(newline);
}

async function loadRealData({ keepPage = true } = {}) {
  const [status, live, ds, modelList, terms, info, tools, logs, environment, jwtList, mcpList] = await Promise.all([
    realApi("/api/status"), fetch("/livez", { cache: "no-store" }).then((response) => ({ status: response.status })).catch(() => ({ status: 0 })), realApi("/api/datasources"), realApi("/api/models"),
    realApi("/api/glossary"), realApi("/api/mcp-info"), realApi("/api/tools").catch(() => ({ cubeCore: [] })),
    realApi("/api/logs"), realApi("/api/environment"), realApi("/api/jwt/tokens").catch(() => ({ tokens: [] })),
    realApi("/api/mcp-servers").catch(() => ({ servers: [], availableModels: [] })),
  ]);
  runtime.status = { ...status, live };
  runtime.info = info;
  Object.assign(environmentConfig, environment.environment || {});

  dataSources.splice(0, dataSources.length, ...(ds.sources || []).map((source) => ({
    name: source.name, desc: source.name === "default" ? "默认数据源" : "业务数据源", type: typeLabel(source.type),
    host: source.host, port: source.port, database: source.database, user: source.user, password: source.password,
    models: 0, checked: "尚未检查", status: "未检查", ssl: !!source.ssl, container: source.container || "",
  })));

  // /meta 只返回 public 模型，不能用它判断 Cube 是否已加载。
  // 服务端通过 Cube 内部编译结果返回 loadedModels，隐藏模型也会包含在内。
  const loadedNames = Array.isArray(modelList.loadedModels) ? modelList.loadedModels : [];
  const docs = await Promise.all((modelList.models || []).map(async (file) => {
    try { return { file, payload: await realApi(`/api/model-doc?name=${encodeURIComponent(file.name)}`) }; }
    catch (error) { return { file, error }; }
  }));
  Object.keys(modelData).forEach((key) => delete modelData[key]);
  models.splice(0, models.length, ...docs.map(({ file, payload, error }) => {
    if (!payload) {
      const id = file.name.replace(/\.ya?ml$/i, "");
      modelData[id] = { form: { id, title: id, source: dataSources.some((item) => item.name === "default") ? "default" : "", table: "", description: error.message, sqlSource: "自定义 SQL（高级）", public: true }, dimensions: [], metrics: [], joins: [], yaml: "", document: { cubes: [] }, filename: file.name };
      return { id, name: id, source: "解析失败", status: "草稿", updated: "刚刚" };
    }
    return uiModelFromDocument(file, payload, loadedNames);
  }));
  dataSources.forEach((source) => { source.models = models.filter((model) => modelData[model.id]?.form.source === source.name).length; });
  if (!modelData[state.model]) state.model = models[0]?.id || "";
  // 以服务器当前文件建立放弃修改的基线，避免沿用初始化占位快照。
  models.forEach((model) => saveModelSnapshot(model.id));
  state.modelStatusHidden = false;
  state.modelState = currentModel()?.pending || currentModel()?.status === "草稿" ? "saved" : "applied";

  glossary.splice(0, glossary.length, ...(terms.items || []).map((item) => [parseTermAliases(item.aliases || item.alias), item.standard, item.type || "指标", item.model || models[0]?.name || "", String(item.description || "").trim()]).filter((item) => item[0].length && item[1]));
  coreTools.splice(0, coreTools.length, ...(tools.cubeCore || []));
  runtime.openapiSchemas = tools.openapiSchemas && typeof tools.openapiSchemas === "object" ? tools.openapiSchemas : {};
  runtime.toolsUpdatedAt = tools.updatedAt || "";
  runtime.jwtTokens = jwtList.tokens || [];
  runtime.mcpServers = mcpList.servers || [];
  runtime.availableMcpModels = mcpList.availableModels || [];
  if (!runtime.mcpServers.some((server) => server.id === state.mcpServer)) state.mcpServer = runtime.mcpServers[0]?.id || "";
  const logText = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
  rawLogs.splice(0, rawLogs.length, ...logText.split("\n").filter(Boolean).slice(-120).map((line) => {
    const time = line.match(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/)?.[0] || "--:--:--";
    const level = line.match(/\b(ERROR|WARN|INFO|DEBUG)\b/i)?.[1]?.toUpperCase() || (line.toLowerCase().includes("error") ? "ERROR" : "INFO");
    return [time, level, line];
  }));
  queryRecords.splice(0, queryRecords.length, ...rawLogs.filter((line) => /load|query|cubejs-api/i.test(line[2])).slice(-30).reverse().map((line) => ({
    time: line[0], title: line[2].slice(0, 70), sub: "cube_api 运行日志", api: "REST", duration: "—", source: "实时日志",
    status: line[1] === "ERROR" ? "失败" : "成功", action: line[1] === "ERROR" ? "query-record-error" : "query-record-detail",
  })));
  runtime.loaded = true;
  if (!keepPage) state.page = "datasources";
  render();
}

async function reloadCurrentRealModel() {
  const model = currentModel();
  const data = currentModelData();
  if (!model || !data?.filename) throw new Error("当前模型文件不存在");
  // 只读取当前文件，避免刷新日志、工具或其他接口失败时阻断“放弃修改”。
  const payload = await realApi(`/api/model-doc?name=${encodeURIComponent(data.filename)}`);
  const next = uiModelFromDocument(
    { name: data.filename, mtime: Date.now(), pending: !!model.pending },
    payload,
    model.status === "已加载" ? [payload.document?.cubes?.[0]?.name] : [],
  );
  const index = models.findIndex((item) => item.id === model.id);
  if (index >= 0) models[index] = { ...model, ...next };
  state.model = next.id;
  // 放弃后内容已恢复到服务器版本；隐藏当前这一次的提示条，但不影响
  // 其他模型已保存草稿对应的全局“应用到 Cube”状态。
  state.modelStatusHidden = true;
  state.modelState = model.pending || model.status === "草稿" ? "saved" : "applied";
  saveModelSnapshot(next.id);
  render();
}

function modelYaml(model, data) {
  return `<div class="yaml-toolbar"><div><strong>YAML 高级模式</strong></div><div class="actions"><button class="btn small" data-action="format-yaml">格式化</button></div></div><textarea class="yaml-editor" id="yamlEditor" data-model-field="yaml" spellcheck="false">${escapeHtml(data.yaml || "")}</textarea>${modelFooter()}`;
};

function openApiParameterRows(tool) {
  const parameters = Array.isArray(tool?.parameters) ? tool.parameters : [];
  if (!parameters.length) return '<div class="tool-empty-state">无显式路径、查询或请求头参数</div>';
  return `<div class="tool-parameter-table"><div class="tool-parameter-row tool-parameter-head"><span>参数</span><span>位置</span><span>类型</span><span>必填</span><span>说明</span></div>${parameters.map((parameter) => {
    const schema = parameter?.schema || {};
    return `<div class="tool-parameter-row"><strong class="mono">${escapeHtml(parameter.name || "未命名")}</strong><span>${escapeHtml(parameter.in || "parameter")}</span><span class="mono">${escapeHtml(openApiSchemaLabel(schema))}</span><span>${parameter.required ? '<b class="tool-required">必填</b>' : '<span class="tool-optional">可选</span>'}</span><span>${escapeHtml(parameter.description || "暂无说明")}</span></div>`;
  }).join("")}</div>`;
}

function openApiSchemaRefName(ref) {
  const value = String(ref || "");
  return value.startsWith("#/components/schemas/") ? value.slice("#/components/schemas/".length) : "";
}

function referencedOpenApiSchemas(schema) {
  const catalog = runtime.openapiSchemas && typeof runtime.openapiSchemas === "object" ? runtime.openapiSchemas : {};
  const names = [];
  const seenObjects = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    const name = openApiSchemaRefName(value.$ref);
    if (name && !names.includes(name)) {
      names.push(name);
      visit(catalog[name]);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
  return names.map((name) => ({ name, schema: catalog[name] })).filter((item) => item.schema);
}

function openApiResolvedSchemaHtml(schema) {
  const references = referencedOpenApiSchemas(schema);
  if (!references.length) return "";
  return `<div class="tool-resolved-schemas"><h4>引用的 Schema</h4>${references.map((item, index) => `<details class="tool-schema-card"${index === 0 ? " open" : ""}><summary><strong class="mono">${escapeHtml(item.name)}</strong><span>components.schemas</span></summary><pre>${escapeHtml(JSON.stringify(item.schema, null, 2))}</pre></details>`).join("")}</div>`;
}

function openApiRequestBody(tool) {
  const body = tool?.requestBody;
  if (!body) return '<div class="tool-empty-state">此工具不需要请求体</div>';
  const content = body.content && typeof body.content === "object" ? body.content : {};
  return `<div class="tool-request-card"><div class="tool-request-title"><strong>请求体</strong>${body.required ? '<b class="tool-required">必填</b>' : '<span class="tool-optional">可选</span>'}</div>${body.description ? `<p>${escapeHtml(body.description)}</p>` : ""}${Object.entries(content).map(([type, media]) => `<div class="tool-media"><div class="tool-media-header"><strong class="mono">${escapeHtml(type)}</strong><span>${escapeHtml(openApiSchemaLabel(media?.schema))}</span></div>${media?.schema ? `<pre>${escapeHtml(JSON.stringify(media.schema, null, 2))}</pre>${openApiResolvedSchemaHtml(media.schema)}` : ""}</div>`).join("")}</div>`;
}

function openApiResponseRows(tool) {
  const responses = tool?.responses && typeof tool.responses === "object" ? tool.responses : {};
  const rows = Object.entries(responses).map(([status, response]) => `<div class="tool-response-row"><strong class="mono">${escapeHtml(status)}</strong><span>${escapeHtml(response?.description || "无响应说明")}</span></div>`).join("");
  return rows || '<div class="tool-empty-state">暂无响应定义</div>';
}

function openApiYamlPreview(tool) {
  if (tool.operationYaml) return tool.operationYaml;
  const lines = [
    `${String(tool.method || "get").toLowerCase()}:`,
    `  path: ${tool.path || ""}`,
    `  operationId: ${tool.name || ""}`,
    `  summary: ${tool.summary || ""}`,
    `  description: ${tool.description || ""}`,
  ];
  if (Array.isArray(tool.parameters) && tool.parameters.length) {
    lines.push("  parameters:", ...tool.parameters.map((parameter) => `    - name: ${parameter.name}\n      in: ${parameter.in || "query"}\n      required: ${Boolean(parameter.required)}\n      description: ${parameter.description || ""}`));
  }
  if (tool.requestBody) lines.push("  requestBody:", `    required: ${Boolean(tool.requestBody.required)}`, `    description: ${tool.requestBody.description || ""}`);
  return lines.join("\n");
}

function renderToolOverview(tool) {
  const parameters = Array.isArray(tool.parameters) ? tool.parameters.filter((parameter) => !parameter?.$ref) : [];
  return `<section class="tool-drawer-section"><div class="tool-overview-grid"><div><span>请求方法</span><strong class="tool-method ${String(tool.method).toLowerCase()}">${escapeHtml(tool.method)}</strong></div><div><span>参数数量</span><strong>${parameters.length}${tool.requestBody ? " + 请求体" : ""}</strong></div><div><span>标签</span><strong>${escapeHtml((tool.tags || []).join("、") || "Cube Core")}</strong></div></div><div class="tool-readonly-block"><h3>接口说明</h3><p class="tool-drawer-description">${escapeHtml(tool.description || "暂无说明")}</p></div>${tool.requestBody ? `<div class="tool-readonly-block"><h3>请求体说明</h3><p class="tool-drawer-description">${escapeHtml(tool.requestBody.description || "暂无说明")}</p></div>` : ""}</section>`;
}

function renderToolDrawer() {
  const drawer = $("#toolCatalogDrawer");
  const tool = coreTools.find((item) => item.name === state.openapiToolName);
  if (!drawer || !tool) return;
  const tab = state.openapiToolTab || "overview";
  const tabContent = tab === "parameters" ? `<section class="tool-drawer-section"><h3>参数定义</h3>${openApiParameterRows(tool)}</section>` : tab === "request" ? `<section class="tool-drawer-section"><h3>请求体</h3>${openApiRequestBody(tool)}</section>` : tab === "responses" ? `<section class="tool-drawer-section"><h3>响应</h3>${openApiResponseRows(tool)}</section>` : tab === "yaml" ? `<section class="tool-drawer-section"><h3>当前操作 YAML</h3><p class="tool-drawer-muted">仅查看从当前 OpenAPI 规范准确切分出的 path、method 和 operation 定义。</p><pre class="tool-yaml-preview">${escapeHtml(openApiYamlPreview(tool))}</pre></section>` : renderToolOverview(tool);
  drawer.querySelector(".tool-drawer-body").innerHTML = tabContent;
  drawer.querySelectorAll("[data-openapi-tab]").forEach((button) => button.classList.toggle("active", button.dataset.openapiTab === tab));
}

function openToolDrawer(name) {
  const tool = coreTools.find((item) => item.name === name);
  if (!tool) return;
  let drawer = $("#toolCatalogDrawer");
  if (!drawer) {
    document.body.insertAdjacentHTML("beforeend", `<div class="tool-drawer-backdrop" id="toolCatalogBackdrop"></div><aside class="tool-drawer" id="toolCatalogDrawer" role="dialog" aria-modal="true" aria-labelledby="toolDrawerTitle" tabindex="-1"><div class="tool-drawer-head"><div><h2 id="toolDrawerTitle"></h2><div class="tool-drawer-endpoint"><p id="toolDrawerPath"></p><button class="btn small" data-action="copy-tool-curl">复制 curl</button></div></div><button class="drawer-close" id="toolCatalogClose" aria-label="关闭工具详情">×</button></div><nav class="tool-drawer-tabs"><button data-openapi-tab="overview">概览</button><button data-openapi-tab="parameters">参数</button><button data-openapi-tab="request">请求体</button><button data-openapi-tab="responses">响应</button><button data-openapi-tab="yaml">YAML</button></nav><div class="tool-drawer-body"></div></aside>`);
    drawer = $("#toolCatalogDrawer");
    $("#toolCatalogClose").onclick = closeToolDrawer;
    // 右侧详情抽屉只能通过明确的关闭按钮退出，点击遮罩不丢失编辑内容。
    $("#toolCatalogBackdrop").onclick = (event) => event.stopPropagation();
    drawer.onclick = async (event) => {
      const tabButton = event.target.closest("[data-openapi-tab]");
      if (tabButton) { state.openapiToolTab = tabButton.dataset.openapiTab; renderToolDrawer(); return; }
      const curlButton = event.target.closest('[data-action="copy-tool-curl"]');
      if (curlButton) {
        const currentTool = coreTools.find((item) => item.name === state.openapiToolName);
        return copyText(toolCurlCommand(currentTool), "curl 已复制");
      }
    };
  }
  state.openapiToolName = name;
  state.openapiToolTab = "overview";
  $("#toolDrawerTitle").textContent = tool.name;
  $("#toolDrawerPath").textContent = `${tool.method} · ${toolEndpointUrl(tool)}`;
  renderToolDrawer();
  $("#toolCatalogBackdrop").classList.add("show");
  drawer.classList.add("show");
  setTimeout(() => drawer.focus());
}

function closeToolDrawer() {
  $("#toolCatalogBackdrop")?.classList.remove("show");
  $("#toolCatalogDrawer")?.classList.remove("show");
}

function currentMcpServer() {
  return (runtime.mcpServers || []).find((item) => item.id === state.mcpServer) || runtime.mcpServers?.[0] || null;
}

function mcpEndpoint(server) {
  const base = String(runtime.info?.cube?.base || window.location.origin).replace(/\/+$/, "");
  return server?.id === "default" ? `${base}/mcp` : `${base}/mcp/${server?.id || ""}`;
}

function renderMcpManagement() {
  const servers = runtime.mcpServers || [];
  if (!state.mcpServer && servers[0]) state.mcpServer = servers[0].id;
  const selected = currentMcpServer();
  if (!["overview", "models", "tokens"].includes(state.mcpTab)) state.mcpTab = "overview";
  const selectedTokens = (runtime.jwtTokens || []).filter((token) => token.mcpServerId === selected?.id);
  const modelNames = new Map(models.map((model) => [model.id, model.name]));
  const serverList = servers.map((server) => `<button class="model-item ${server.id === selected?.id ? "active" : ""}" data-action="select-mcp-server" data-mcp-server-id="${escapeHtml(server.id)}"><span><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.id)} · ${server.modelIds.length} 个语义模型</small></span>${server.enabled ? '<i class="status-dot applied"></i>' : '<i class="status-dot"></i>'}</button>`).join("");
  const pageActions = '<button class="btn" data-action="reveal-secret">JWT 签名设置</button><button class="btn primary" data-action="new-mcp-server">创建 MCP Server</button>';
  if (!selected) return pageHead("MCP 管理", "创建独立 MCP Server，并按语义模型授予只读查询权限。", pageActions) + '<section class="card empty-page"><div class="empty"><b>暂无 MCP Server</b><span>请先创建一个 MCP Server 并绑定至少一个已加载的语义模型。</span></div></section>';
  const tokens = selectedTokens.map((record) => `<tr><td><strong>${escapeHtml(record.purpose || "service-account")}</strong><small class="mono">${escapeHtml(tokenDisplayKey(record))}</small></td><td>${escapeHtml(tokenDate(record.createdAt))}</td><td>${badge(tokenStatusLabel(record.status))}</td><td><button class="link" data-action="copy-jwt-token" data-token-id="${escapeHtml(record.id)}">复制</button><button class="link danger" data-action="delete-mcp-token" data-mcp-server-id="${escapeHtml(selected.id)}" data-token-id="${escapeHtml(record.id)}">撤销</button></td></tr>`).join("") || '<tr><td colspan="4"><span class="muted">暂无服务密钥</span></td></tr>';
  const modelCards = selected.modelIds.map((id) => {
    const model = models.find((item) => item.id === id);
    const source = modelData[id]?.form?.source || String(model?.source || "default").split(".")[0] || "default";
    return `<div class="mcp-model-card"><strong>${escapeHtml(modelNames.get(id) || id)}</strong><small class="mono">${escapeHtml(id)}</small><small>数据源：${escapeHtml(source)} · ${escapeHtml(model?.status || "未加载")}</small></div>`;
  }).join("") || '<div class="empty compact"><b>暂无绑定模型</b></div>';
  const overview = `<div class="mcp-overview-grid"><section class="mcp-section"><div class="mcp-section-head"><h3>接入信息</h3>${badge(selected.enabled ? "正常" : "已停用")}</div><div class="mcp-section-body"><div class="mcp-endpoint-row"><span>Endpoint</span><code>${escapeHtml(mcpEndpoint(selected))}</code><button class="link" data-action="copy-mcp-endpoint" data-mcp-server-id="${escapeHtml(selected.id)}">复制</button></div><div class="mcp-endpoint-row"><span>Transport</span><code>streamable-http</code><span></span></div><div class="mcp-endpoint-row"><span>鉴权</span><code>Authorization: Bearer &lt;MCP Server JWT&gt;</code><span></span></div></div></section><section class="mcp-section"><div class="mcp-section-head"><h3>说明（instructions）</h3></div><div class="mcp-section-body mcp-instructions">${escapeHtml(selected.instructions || "仅使用 cube_meta 返回的语义模型和成员；禁止猜测成员名称。")}</div></section><section class="mcp-section" style="grid-column:1/-1"><div class="mcp-section-head"><h3>Server 设置</h3></div><div class="mcp-section-body"><div class="mcp-endpoint-row"><span>名称</span><strong>${escapeHtml(selected.name)}</strong><span></span></div><div class="mcp-endpoint-row"><span>Server ID</span><code>${escapeHtml(selected.id)}</code><span></span></div><div class="mcp-endpoint-row"><span>状态</span><span>${selected.enabled ? "已启用" : "已停用"}</span><span></span></div><div class="mcp-settings-actions"><button class="btn ${selected.enabled ? "" : "primary"}" data-action="toggle-mcp-server" data-mcp-server-id="${escapeHtml(selected.id)}">${selected.enabled ? "停用 Server" : "启用 Server"}</button>${selected.id !== "default" ? `<button class="btn danger" data-action="delete-mcp-server" data-mcp-server-id="${escapeHtml(selected.id)}">删除 MCP Server</button>` : ""}</div></div></section></div>`;
  const modelPanel = `<section class="mcp-section"><div class="mcp-section-head"><div><h3>绑定语义模型</h3></div><span class="muted">${selected.modelIds.length} 个</span></div><div class="mcp-section-body"><div class="mcp-model-grid">${modelCards}</div></div></section>`;
  const tokenPanel = `<section class="mcp-section"><div class="mcp-section-head"><h3>服务密钥</h3><button class="btn primary small" data-action="create-mcp-token" data-mcp-server-id="${escapeHtml(selected.id)}">创建密钥</button></div><div class="table-wrap"><table class="table"><thead><tr><th>备注</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${tokens}</tbody></table></div></section>`;
  const panels = { overview, models: modelPanel, tokens: tokenPanel };
  return pageHead("MCP 管理", "每个 MCP Server 使用独立地址、独立密钥和语义模型白名单。", pageActions) +
    `<div class="model-workbench mcp-workbench"><aside class="model-browser"><div class="model-browser-head"><strong>MCP Server</strong><span class="muted">${servers.length}</span></div><div class="model-list">${serverList}</div></aside><div class="model-detail"><div class="model-titlebar mcp-detail-head"><div class="model-title"><span class="integration-icon">⌘</span><div><h2>${escapeHtml(selected.name)}</h2><p class="mono">${escapeHtml(selected.id)} · ${selected.modelIds.length} 个语义模型 · ${selectedTokens.filter((token) => token.status === "active").length} 个有效密钥</p></div></div><div class="actions"><button class="btn" data-action="edit-mcp-server" data-mcp-server-id="${escapeHtml(selected.id)}">编辑</button>${badge(selected.enabled ? "正常" : "已停用")}</div></div><div class="tabs mcp-tabs">${[["overview", "概览"], ["models", "语义模型"], ["tokens", "服务密钥"]].map(([id, label]) => `<button class="${state.mcpTab === id ? "active" : ""}" data-action="mcp-tab" data-mcp-tab="${id}">${label}</button>`).join("")}</div><div class="mcp-panel">${panels[state.mcpTab] || overview}</div></div></div>`;
}

function renderIntegrations() {
  const localBase = window.location.origin.replace(/\/+$/, "");
  const cube = runtime.info?.cube || { base: localBase, openapi: `${localBase}/openapi.yaml`, readyz: `${localBase}/readyz`, livez: `${localBase}/livez` };
  const ready = runtime.status?.ready?.status === 200 ? "健康" : "异常";
  const live = runtime.status?.live?.status === 200 ? "健康" : "异常";
  const visibleTools = coreTools;
  const toolCards = visibleTools.map((item) => {
    const parameterCount = Array.isArray(item.parameters) ? item.parameters.length : 0;
    const hasBody = !!item.requestBody;
    return `<div class="tool-catalog-item" tabindex="0" data-tool-detail="${escapeHtml(item.name)}" role="button" aria-label="查看 ${escapeHtml(item.name)} 详情">
      <div class="tool-catalog-main"><div class="tool-catalog-top"><span class="tool-method ${String(item.method).toLowerCase()}">${escapeHtml(item.method)}</span><span class="tool-path mono">${escapeHtml(item.path)}</span></div>
      <div class="tool-catalog-name">${escapeHtml(item.name)}</div><div class="tool-catalog-summary">${escapeHtml(item.summary || "暂无摘要")}</div>
      <p class="tool-catalog-description">${escapeHtml(item.description || "暂无详细说明")}</p>
      <div class="tool-catalog-meta"><span>${parameterCount} 个参数${hasBody ? " · 含请求体" : ""}</span></div></div>
    </div>`;
  }).join("");
  return pageHead("集成中心", "集中查看 Cube 端点和 OpenAPI 兼容工具；原生 MCP 请在“MCP 管理”中配置。", '<button class="btn" data-action="refresh">↻ 刷新</button>') +
    `<div class="grid cols-2"><section class="card wide-card"><div class="card-head"><div><h2>Cube 端点信息</h2></div></div><div class="table-wrap"><table class="table"><tbody>${[["API Base", cube.base, ""], ["OpenAPI", cube.openapi || new URL("/openapi.yaml", window.location.origin).href, ""], ["就绪检查", cube.readyz, ready], ["存活检查", cube.livez || `${String(cube.base || "").replace(/\/+$/, "")}/livez`, live]].map((row) => `<tr><th>${row[0]}</th><td class="mono">${escapeHtml(row[1])}</td><td>${row[2] ? badge(row[2]) : '<button class="link" data-action="copy-endpoint">复制</button>'}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="card wide-card tool-catalog-card"><div class="card-head"><div><h2>openapi.yaml 工具目录</h2></div><div class="actions"><button class="btn primary small" data-action="update-openapi-tools">更新</button><button class="btn small" data-action="import-openapi">导入</button><button class="btn small" data-action="export-openapi">导出</button></div></div>
      <div class="tool-catalog-list">${toolCards}</div></section></div>`;
};

function monitorLogContent() {
  if (state.monitorLogView === "queries") {
    return `<div class="toolbar" style="padding:14px 18px;margin:0;border-bottom:1px solid var(--line2)"><div class="actions"><input class="search-input" id="queryLogSearch" placeholder="搜索查询记录"><select class="search-input" id="queryLogStatus"><option value="all">全部结果</option><option value="成功">成功</option><option value="失败">失败</option></select></div><span class="muted">当前日志提取 · ${queryRecords.length} 条</span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>记录</th><th>API</th><th>耗时</th><th>来源</th><th>结果</th></tr></thead><tbody>${queryRecords.map((record) => `<tr data-query-status="${record.status}" data-query-text="${escapeHtml(Object.values(record).join(" ").toLowerCase())}"><td>${record.time}</td><td><strong>${escapeHtml(record.title)}</strong><small>${record.sub}</small></td><td>${record.api}</td><td>${record.duration}</td><td>${record.source}</td><td>${badge(record.status)}</td></tr>`).join("") || '<tr><td colspan="6"><div class="empty"><b>暂无查询记录</b>运行测试查询后刷新即可看到记录</div></td></tr>'}</tbody></table></div>`;
  }
  return `<div class="toolbar" style="padding:14px 18px;margin:0;border-bottom:1px solid var(--line2)"><input class="search-input" id="rawLogSearch" placeholder="搜索日志"><div class="actions"><span class="muted">最近 ${rawLogs.length} 行</span><button class="btn small" data-action="download-logs">下载</button></div></div><div class="card-body"><div class="log-shell">${rawLogs.map((log) => `<div class="log-line" data-log-text="${escapeHtml(log.join(" ").toLowerCase())}"><span class="log-time">${log[0]}</span> <span class="log-${log[1].toLowerCase()}">${log[1]}</span> ${escapeHtml(log[2])}</div>`).join("") || "暂无日志"}</div></div>`;
};

function renderMonitor() {
  const services = runtime.status?.ps || [];
  const rows = services.map((service) => `<tr><td><strong>${escapeHtml(service.Name || service.Service || "Cube 服务")}</strong></td><td>${badge(String(service.State).toLowerCase() === "running" ? "正常" : "有风险")}</td><td>${escapeHtml(service.Status || service.State || "—")}</td><td class="mono">${escapeHtml(service.Publishers?.map?.((item) => item.PublishedPort).filter(Boolean).join(", ") || "—")}</td></tr>`).join("");
  const overall = runtime.status?.ready?.status === 200 ? "正常" : "有风险";
  return pageHead("系统监控", "查看真实 Cube 容器状态与 cube_api 日志。", '<button class="btn" data-action="refresh-monitor">↻ 刷新</button>') +
    `<div class="grid cols-2"><section class="card monitor-status"><div class="card-head"><div><h2>Cube 容器状态</h2></div>${badge(overall)}</div><div class="table-wrap"><table class="table"><thead><tr><th>容器</th><th>状态</th><th>运行信息</th><th>端口</th></tr></thead><tbody>${rows || '<tr><td colspan="4">暂无状态数据</td></tr>'}</tbody></table></div></section><section class="card log-card"><div class="card-head"><div><h2>cube_api 日志</h2></div><div class="segmented"><button class="${state.monitorLogView === "raw" ? "active" : ""}" data-log-view="raw">原始日志</button><button class="${state.monitorLogView === "queries" ? "active" : ""}" data-log-view="queries">查询记录</button></div></div><div class="log-view-body">${monitorLogContent()}</div></section></div>`;
};

function bindPage() {
  bindBasePage();
  const yaml = $("#yamlEditor");
  if (yaml) yaml.oninput = () => { currentModelData().yaml = yaml.value; setModelState("dirty"); };
  $$("[data-tool-detail]").forEach((card) => {
    card.onclick = (event) => {
      if (event.target.closest("[data-action]")) return;
      openToolDrawer(card.dataset.toolDetail);
    };
    card.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openToolDrawer(card.dataset.toolDetail); }
    };
  });
};

async function refreshAndToast(message = "真实数据已刷新") {
  await loadRealData();
  toast(message);
}

async function applyRealDatasources({ allowEmpty = false } = {}) {
  await realApi("/api/datasources/apply", { method: "POST", body: JSON.stringify({ allowEmpty }) });
  await loadRealData();
}

function realSourceModal(index = null) {
  const editing = index !== null ? dataSources[index] : null;
  const source = editing || { name: "", desc: "", type: "MySQL", host: "", port: "3306", database: "", user: "root", ssl: false, container: "" };
  openModal({ title: editing ? "编辑数据源" : "添加数据源", sub: "保存配置后会自动应用到 Cube。", icon: "", wide: true, modalClass: "source-modal", confirm: "保存配置", body: `<div class="source-modal-form"><div class="grid cols-2"><label class="field">数据源名称<input id="sourceName" value="${escapeHtml(source.name)}" ${editing?.name === "default" ? "disabled" : ""}></label><label class="field">数据库类型<select id="sourceType">${["MySQL", "PostgreSQL", "ClickHouse"].map((type) => `<option ${type === source.type ? "selected" : ""}>${type}</option>`).join("")}</select></label><label class="field">主机<input id="sourceHost" value="${escapeHtml(source.host)}" placeholder="例如 127.0.0.1"></label><label class="field">端口<input id="sourcePort" value="${escapeHtml(source.port)}"></label><label class="field">数据库名<input id="sourceDatabase" value="${escapeHtml(source.database)}"></label><label class="field">用户名<input id="sourceUser" value="${escapeHtml(source.user)}" autocomplete="username"></label><label class="field">密码<input id="sourcePassword" type="password" placeholder="${editing ? "留空保持原密码" : "请输入数据库密码"}" autocomplete="new-password"></label></div><label class="source-ssl-row"><span class="source-ssl-copy"><strong>SSL 连接</strong><small>需要数据库服务端支持 SSL 时开启</small></span><input id="sourceSsl" type="checkbox" ${source.ssl ? "checked" : ""}></label></div>`, onConfirm: async () => {
    const payload = { name: $("#sourceName").value.trim(), oldName: editing?.name || "", type: $("#sourceType").value.toLowerCase().replace("postgresql", "postgres"), host: $("#sourceHost").value.trim(), port: $("#sourcePort").value.trim(), database: $("#sourceDatabase").value.trim(), user: $("#sourceUser").value.trim(), password: $("#sourcePassword").value, container: source.container || "", ssl: $("#sourceSsl").checked };
    if (!payload.name || !payload.host || !payload.database) return toast("请填写名称、主机和数据库名");
    setModalBusy();
    try {
      await realApi("/api/datasources", { method: "POST", body: JSON.stringify(payload) });
      await applyRealDatasources();
      closeModal();
      toast("数据源配置已保存并应用");
    } catch (error) {
      restoreModalActions("保存配置");
      toast(`保存或应用失败：${compactRealError(error)}`);
    }
  } });
}

function realNewModelModal() {
  openModal({ title: "新建真实语义模型", sub: "先创建 YAML 模板，再进入编辑器完善。", icon: "◇", confirm: "创建模型", body: '<label class="field">模型标识<input id="newModelId" placeholder="例如 orders"></label>', onConfirm: async () => {
    const name = $("#newModelId").value.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return toast("模型标识需以字母开头，仅含字母、数字和下划线");
    try { await realApi("/api/models", { method: "POST", body: JSON.stringify({ name }) }); closeModal(); await loadRealData(); state.model = name; state.modelState = "saved"; render(); toast("模型模板已创建"); }
    catch (error) { toast(`创建失败：${error.message}`); }
  } });
}

function realAutoModelModal() {
  let sourceName = dataSources[0]?.name || "";
  const sourceOptions = dataSources.map((item, index) => {
    const type = item.type || "MySQL";
    return `<button class="auto-source-option${index === 0 ? " active" : ""}" type="button" role="option" aria-selected="${index === 0}" data-source="${escapeHtml(item.name)}"><span class="auto-source-icon">${escapeHtml(type.slice(0, 1).toUpperCase())}</span><span class="auto-source-option-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(type)} · ${escapeHtml(item.database || "暂无数据库名称")}</small></span></button>`;
  }).join("");
  openModal({
    title: "自动建模",
    sub: "",
    icon: "◇",
    wide: true,
    modalClass: "auto-model-modal",
    confirm: "生成模型",
    body: `<div class="auto-model-form"><aside class="field auto-source-field" aria-label="数据源列表"><div class="auto-source-heading"><strong>数据源</strong></div><label class="auto-source-search"><span aria-hidden="true">⌕</span><input id="autoSourceSearch" type="search" placeholder="搜索数据源" aria-label="搜索数据源" autocomplete="off"></label><div class="auto-source-list" id="auto-source-list" role="listbox">${sourceOptions || '<span class="auto-source-empty">暂无数据源</span>'}</div></aside><section class="field auto-table-field" aria-label="物理表选择"><div class="auto-table-pane-head"><h3>选择物理表</h3></div><div class="auto-table-toolbar"><label class="auto-table-search"><span aria-hidden="true">⌕</span><input id="autoTableSearch" type="search" placeholder="搜索表名或中文注释" aria-label="搜索表名或中文注释" autocomplete="off"></label></div><div id="autoTablePanel" class="auto-table-panel"><div class="auto-table-loading">正在读取真实数据库结构…</div></div><div class="auto-table-foot"><div class="auto-table-foot-note"><i>i</i><span id="autoModelFootNote">请选择至少 1 张物理表</span></div><div class="auto-table-foot-actions"><button class="btn" id="autoModelCancel" type="button">取消</button><button class="btn primary" id="autoModelGenerate" type="button" disabled>生成模型</button></div></div></section></div>`,
    afterOpen: () => {
      const panel = $("#autoTablePanel");
      const footNote = $("#autoModelFootNote");
      const sourceList = $("#auto-source-list");
      const sourceSearch = $("#autoSourceSearch");
      const generateButton = $("#autoModelGenerate");
      const setFootNote = (count) => { if (footNote) footNote.textContent = count ? `已选择 ${count} 张表` : "请选择至少 1 张物理表"; if (generateButton) generateButton.disabled = count === 0; };
      setFootNote(0);
      const filterSources = () => {
        const query = sourceSearch?.value.trim().toLowerCase() || "";
        sourceList?.querySelectorAll("[data-source]").forEach((option) => {
          const matched = !query || option.textContent.toLowerCase().includes(query);
          option.hidden = !matched;
          option.style.display = matched ? "flex" : "none";
        });
      };
      const loadTables = async () => {
        panel.innerHTML = '<div class="auto-table-loading">正在读取真实数据库结构…</div>';
        setFootNote(0);
        if (!sourceName) {
          panel.innerHTML = '<div class="auto-table-empty">暂无数据源，请先新增并测试数据库连接。</div>';
          return;
        }
        try {
          const result = await realApi(`/api/db/tables?ds=${encodeURIComponent(sourceName)}`);
          const tables = result.tables || [];
          panel.innerHTML = tables.length
            ? `<div class="auto-table-fixed-head"><div class="auto-table-select-all"><label><input id="autoTableSelectAll" type="checkbox" aria-label="全选当前列表"></label><span class="auto-table-column-label">原始表名</span><span class="auto-table-column-label">表中文注释</span><span class="auto-table-column-label auto-table-rows-label">行数</span></div></div><div class="auto-table-scroll">${tables.map((item) => `<label class="auto-table-option"><input type="checkbox" name="autoTable" value="${escapeHtml(item.full)}" data-db="${escapeHtml(item.db)}" data-table="${escapeHtml(item.name)}"><span class="auto-table-name mono">${escapeHtml(item.name)}</span><span class="auto-table-comment">${item.comment ? escapeHtml(item.comment) : "暂无中文注释"}</span><span class="auto-table-rows">${escapeHtml(item.rows ?? "—")}</span></label>`).join("")}<div id="autoTableNoMatch" class="auto-table-empty" hidden>没有匹配的物理表</div></div>`
            : '<div class="auto-table-empty">未发现数据表</div>';
          if (!tables.length) return;
          const search = $("#autoTableSearch");
          const selectAll = $("#autoTableSelectAll");
          const noMatch = $("#autoTableNoMatch");
          const rows = $$(".auto-table-option", panel);
          const inputs = $$('input[name="autoTable"]', panel);
          const updateSelection = () => {
            const visibleInputs = rows.filter((row) => !row.hidden).map((row) => $("input", row));
            const selectedCount = inputs.filter((input) => input.checked).length;
            const visibleSelected = visibleInputs.filter((input) => input.checked).length;
            selectAll.checked = visibleInputs.length > 0 && visibleSelected === visibleInputs.length;
            selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleInputs.length;
            setFootNote(selectedCount);
          };
          const applyFilter = () => {
            const query = search.value.trim().toLowerCase();
            let visibleCount = 0;
            rows.forEach((row) => {
              const input = $("input", row);
              const text = `${input.dataset.table} ${$(".auto-table-comment", row).textContent}`.toLowerCase();
              const matched = !query || text.includes(query);
              row.hidden = !matched;
              row.style.display = matched ? "grid" : "none";
              if (!row.hidden) visibleCount += 1;
            });
            noMatch.hidden = visibleCount > 0;
            updateSelection();
          };
          search.oninput = applyFilter;
          search.onsearch = applyFilter;
          search.onkeyup = applyFilter;
          panel.onchange = (event) => {
            if (event.target === selectAll) rows.filter((row) => !row.hidden).forEach((row) => { $("input", row).checked = selectAll.checked; });
            updateSelection();
          };
          applyFilter();
        } catch (error) { panel.innerHTML = `<div class="auto-table-empty auto-table-error">表清单读取失败：${escapeHtml(error.message)}</div>`; }
      };
      sourceSearch?.addEventListener("input", filterSources);
      sourceList?.addEventListener("click", (event) => {
        const option = event.target.closest("[data-source]");
        if (!option) return;
        sourceName = option.dataset.source;
        sourceList.querySelectorAll(".auto-source-option").forEach((item) => {
          const active = item === option;
          item.classList.toggle("active", active);
          item.setAttribute("aria-selected", String(active));
        });
        loadTables();
      });
      $("#autoModelCancel")?.addEventListener("click", closeModal);
      generateButton?.addEventListener("click", () => $("#modalConfirm")?.click());
      filterSources();
      loadTables();
    },
    onConfirm: async () => {
      const selected = $$('input[name="autoTable"]:checked', $("#autoTablePanel"));
      if (!selected.length) return toast("请选择至少一张要建模的物理表");
      const items = selected.map((input) => ({ db: input.dataset.db, table: input.dataset.table }));
      try {
        const result = await realApi("/api/db/generate", { method: "POST", body: JSON.stringify({ items, ds: sourceName, save: true }) });
        if (!result.ok) throw new Error(result.failed || "模型生成失败");
        closeModal(); await loadRealData(); state.model = items[0].table; state.modelState = "saved"; render(); toast(`已生成 ${items.length} 个模型草稿，尚未应用到 Cube`);
      } catch (error) { toast(`自动建模失败：${error.message}`); }
    },
  });
}

function realRemodelModel() {
  const model = currentModel();
  const data = currentModelData();
  if (!model || !data?.form?.table) return toast("当前模型没有可用的物理表，无法重新建模");
  const source = data.form.source || "default";
  const tableRef = String(data.form.table);
  const split = tableRef.indexOf(".");
  const db = split > 0 ? tableRef.slice(0, split) : (dataSources.find((item) => item.name === source)?.database || "");
  const table = split > 0 ? tableRef.slice(split + 1) : tableRef;
  if (!db || !table) return toast("无法识别当前模型的数据库和物理表");
  openModal({
    title: `重新建模“${model.name}”？`,
    sub: "将按当前数据源重新读取表结构并覆盖模型 YAML。",
    icon: "↻",
    confirm: "确认重新建模",
    body: `<div class="soft-box orange"><strong>${escapeHtml(source)} · ${escapeHtml(db)}.${escapeHtml(table)}</strong><p class="muted" style="margin:7px 0 0">维度字段将以当前数据库结构为准，同步新增、删除和类型变更；已有字段的标题、描述、可见性及指标/关联配置会保留，写入前会创建 .bak 备份。</p></div>`,
    onConfirm: async () => {
      try {
        const result = await realApi("/api/db/generate", { method: "POST", body: JSON.stringify({ items: [{ db, table }], ds: source, save: true }) });
        if (!result.ok) throw new Error(result.failed || "模型生成失败");
        closeModal();
        await loadRealData();
        state.model = model.id;
        state.modelState = "saved";
        render();
        toast(`已按 ${db}.${table} 重新生成草稿，尚未应用到 Cube`);
      } catch (error) { toast(`重新建模失败：${error.message}`); }
    },
  });
}

function realTermModal(index = null) {
  const item = index === null ? [[], "", "指标", "", ""] : normalizeGlossaryItem(glossary[index]);
  openModal({ title: index === null ? "新增业务术语" : "编辑业务术语", sub: "一个标准术语可配置多个别名，并填写业务定义。", icon: "◎", confirm: "保存术语", body: `<div class="grid cols-2"><label class="field">标准术语<input id="termStandard" value="${escapeHtml(item[1])}" ${index === null ? "" : "disabled"}></label><label class="field" style="grid-column:1/-1">术语描述<textarea id="termDescription" placeholder="例如：订单实际支付金额的汇总值">${escapeHtml(item[4])}</textarea></label><label class="field" style="grid-column:1/-1">别名<textarea id="termAliases" placeholder="例如：GMV、成交额、交易额">${escapeHtml(termAliases(item).join("\n"))}</textarea><small>每行一个，也可使用中文逗号、英文逗号或顿号分隔。</small></label></div>`, onConfirm: async () => {
    const aliases = parseTermAliases($("#termAliases").value); const standard = $("#termStandard").value.trim();
    if (!aliases.length || !standard) return toast("请填写标准术语和至少一个别名");
    try { await realApi("/api/glossary", { method: "POST", body: JSON.stringify({ aliases, standard, description: $("#termDescription").value.trim() }) }); closeModal(); await refreshAndToast("业务术语已保存"); }
    catch (error) { toast(`保存失败：${error.message}`); }
  } });
}

async function saveRealModel(apply, { silent = false, preserveView = false, onFailure = null } = {}) {
  const data = currentModelData();
  if (!data) return;
  const yamlEditor = $("#yamlEditor");
  // YAML 是唯一事实源。基础信息、维度描述/可见性等表单操作会先回写
  // data.yaml，这里始终提交同一份 YAML，避免本地对象与文件产生双主源。
  const content = yamlEditor ? yamlEditor.value : data.yaml;
  const payload = { name: data.filename, content, apply };
  state.modelState = apply ? "applying" : "saving";
  if (preserveView) refreshModelPublishButton(); else render();
  try {
    // 先在客户端请求同一套服务端校验，避免把长篇 YAML 解析堆栈直接显示给用户。
    if (yamlEditor) {
      checkCommonYamlMistakes(yamlEditor.value);
      await realApi("/api/model-doc/validate", { method: "POST", body: JSON.stringify({ content: yamlEditor.value }) });
    }
    await realApi("/api/model-doc", { method: "PUT", body: JSON.stringify(payload) });
    if (apply) await new Promise((resolve) => setTimeout(resolve, 2500));
    await loadRealData();
    if (!apply) {
      state.modelStatusHidden = false;
      if (preserveView) refreshModelPublishButton(); else render();
    }
    if (!silent) toast(apply ? "模型已保存并应用到 Cube" : "模型草稿已写入文件并创建备份");
  } catch (error) {
    if (preserveView) {
      onFailure?.(error);
      setModelState("dirty");
    } else {
      state.modelState = "dirty";
      render();
    }
    toast(`模型保存失败：${compactRealError(error, "YAML 校验失败")}`);
  }
}

async function downloadProtected(path, filename, type = "application/octet-stream") {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${localStorage.getItem(REAL_TOKEN_KEY) || ""}` } });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function downloadText(content, filename, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function chooseLocalFile(accept, callback) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => callback(input.files?.[0]);
  input.click();
}

function modelImportName(cubeName, filename) {
  const base = String(cubeName || filename.replace(/\.ya?ml$/i, "") || "imported_model")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "") || "imported_model";
  return `${base}.yml`;
}

async function watchModelApply(jobId, fallbackCount) {
  if (!jobId) throw new Error("发布任务未创建");
  const startedAt = Date.now();
  const timeoutMs = 120000;
  for (;;) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("发布超时：Cube 未在规定时间内完成更新，请检查模型或服务状态后重试");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await realApi(`/api/models/apply-status?id=${encodeURIComponent(jobId)}`);
    const job = result.job || {};
    if (job.status === "running") continue;
    if (job.status === "succeeded") {
      await loadRealData();
      toast(`已应用 ${job.applied?.length || fallbackCount} 个模型到 Cube`);
      return;
    }
    throw new Error(job.error || "后台发布失败");
  }
}

function previewModelImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("无法读取模型文件");
  reader.onload = async () => {
    const content = String(reader.result || "");
    try {
      const validation = await realApi("/api/model-doc/validate", { method: "POST", body: JSON.stringify({ content }) });
      const cubeName = validation.cubes?.find(Boolean) || file.name.replace(/\.ya?ml$/i, "");
      const name = modelImportName(cubeName, file.name);
      openModal({
        title: "导入语义模型",
        sub: `${file.name} · ${validation.cubes?.length || 0} 个 Cube 定义`,
        icon: "↑",
        confirm: "保存模型",
        body: `<div class="soft-box"><strong>YAML 校验通过</strong><p class="muted" style="margin:7px 0 0;line-height:1.7">将保存为 <span class="mono">${escapeHtml(name)}</span>。如果同名文件已存在，系统会先创建 .bak 备份；导入后需要在语义模型页继续检查并应用。</p></div>`,
        onConfirm: async () => {
          try {
            await realApi("/api/model-doc", { method: "PUT", body: JSON.stringify({ name, content: validation.formatted || content, apply: false }) });
            closeModal();
            await loadRealData();
            state.model = cubeName;
            render();
            toast(`模型已导入：${name}`);
          } catch (error) { toast(`导入模型失败：${compactRealError(error)}`); }
        },
      });
    } catch (error) { toast(`模型导入校验失败：${compactRealError(error, "YAML 校验失败")}`); }
  };
  reader.readAsText(file);
}

async function exportCurrentModel() {
  const model = currentModel();
  const data = currentModelData();
  if (!model || !data?.yaml) return toast("当前没有可导出的模型");
  downloadText(data.yaml, data.filename || `${model.id}.yml`, "application/yaml;charset=utf-8");
  toast(`模型已导出：${data.filename || model.id}`);
}

function previewOpenApiImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => toast("无法读取 OpenAPI 文件");
  reader.onload = () => {
    const content = String(reader.result || "");
    if (!content.trim()) return toast("OpenAPI 文件为空");
    openModal({
      title: "导入 openapi.yaml",
      sub: `${file.name} · ${(new Blob([content]).size / 1024).toFixed(1)} KB`,
      icon: "↑",
      confirm: "备份并导入",
      body: '<div class="soft-box orange"><strong>导入会替换当前工具目录源文件</strong><p class="muted" style="margin:7px 0 0;line-height:1.7">服务端会校验 OpenAPI 结构，并在写入前备份当前 YAML。导入后点击“更新工具”重新解析工具目录。</p></div>',
      onConfirm: async () => {
        try {
          const result = await realApi("/api/openapi/source", { method: "POST", body: JSON.stringify({ content }) });
          closeModal();
          const tools = await realApi("/api/tools/refresh", { method: "POST", body: "{}" });
      coreTools.splice(0, coreTools.length, ...(tools.cubeCore || []));
          runtime.openapiSchemas = tools.openapiSchemas && typeof tools.openapiSchemas === "object" ? tools.openapiSchemas : {};
          runtime.toolsUpdatedAt = tools.updatedAt || "";
          render();
          toast(`OpenAPI 已导入，解析 ${result.paths} 个接口`);
        } catch (error) { toast(`导入 OpenAPI 失败：${compactRealError(error)}`); }
      },
    });
  };
  reader.readAsText(file);
}

function parseGlossaryImportText(text, filename = "") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("文件内容为空");
  try {
    const parsed = JSON.parse(raw);
    const source = parsed?.package && typeof parsed.package === "object" ? parsed.package : parsed;
    const items = Array.isArray(source) ? source : source.items;
    if (!Array.isArray(items)) throw new Error("JSON 中未找到 items 数组");
    return items.map((item) => ({ standard: String(item.standard || "").trim(), description: String(item.description || "").trim(), aliases: parseTermAliases(item.aliases || item.alias) })).filter((item) => item.standard && item.aliases.length);
  } catch (error) {
    if (String(filename).toLowerCase().endsWith(".json")) throw error;
    const items = [];
    raw.split(/\r?\n/).forEach((line, index) => {
      const value = line.trim();
      if (!value || (index === 0 && /standard|标准术语/i.test(value))) return;
      const match = value.match(/^(.+?)\s*[:=：]\s*(.+)$/);
      if (match) items.push({ aliases: parseTermAliases(match[1]), standard: match[2].trim() });
    });
    if (!items.length) throw new Error("未识别到术语。JSON 请提供 items；文本请使用“别名:标准术语”格式");
    return items;
  }
}

function previewGlossaryImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const items = parseGlossaryImportText(reader.result, file.name);
      if (!items.length) throw new Error("没有可导入的有效术语");
      openModal({
        title: "导入业务术语",
        sub: `${file.name} · ${items.length} 个标准术语`,
        icon: "◎",
        confirm: "开始导入",
        body: `<div class="soft-box"><strong>术语独立迁移</strong><p class="muted" style="margin:7px 0 0;line-height:1.7">导入不会修改 Cube 模型或数据库连接。相同标准术语将按所选策略处理。</p></div><label class="field" style="margin-top:14px">导入策略<select id="glossImportMode"><option value="merge">合并：保留现有术语并追加别名</option><option value="replace">覆盖：以文件内容替换当前术语表</option></select></label><div class="soft-box" style="margin-top:12px"><strong>示例</strong><p class="muted" style="margin:7px 0 0">${escapeHtml(items.slice(0, 3).map((item) => `${item.standard}：${item.aliases.join("、")}`).join("；"))}</p></div>`,
        onConfirm: async () => {
          try {
            const mode = $("#glossImportMode")?.value || "merge";
            const result = await realApi("/api/glossary/import", { method: "POST", body: JSON.stringify({ items, mode }) });
            closeModal();
            await refreshAndToast(`已${mode === "replace" ? "覆盖" : "合并"} ${result.total} 个标准术语`);
          } catch (error) { toast(`导入失败：${error.message}`); }
        },
      });
    } catch (error) { toast(`术语文件无法导入：${error.message}`); }
  };
  reader.onerror = () => toast("无法读取术语文件");
  reader.readAsText(file);
}

async function handleAction(action, element) {
  const index = element?.dataset.index !== undefined ? Number(element.dataset.index) : null;
  try {
    if (action === "toggle-public") {
      const data = currentModelData();
      if (!data) return;
      const previousPublic = data.form.public;
      data.form.public = !data.form.public;
      updateModelVisibilityToggle(data.form.public, true);
      syncYamlPreview(data, "model");
      return saveRealModel(false, {
        silent: true,
        preserveView: true,
        onFailure: () => {
          data.form.public = previousPublic;
          syncYamlPreview(data, "model");
          updateModelVisibilityToggle(previousPublic);
        },
      }).finally(() => updateModelVisibilityToggle(data.form.public));
    }
    if (action === "toggle-member-public") {
      const kind = element.dataset.kind;
      const memberTableScroll = captureMemberTableScroll(element);
      const data = currentModelData();
      const item = data?.[kind]?.[Number(element.dataset.index)];
      if (!item) return;
      const previousPublic = item.public !== false;
      item.public = item.public === false;
      updateVisibilityToggle(element, item.public, true);
      syncYamlPreview(data, kind);
      return saveRealModel(false, {
        silent: true,
        preserveView: true,
        onFailure: () => {
          item.public = previousPublic;
          syncYamlPreview(data, kind);
          updateVisibilityToggle(element, previousPublic);
        },
      }).finally(() => {
        restoreMemberTableScroll(memberTableScroll);
        updateVisibilityToggle(element, item.public);
      });
    }
    if (action === "new-source") return realSourceModal();
    if (action === "edit-source") return realSourceModal(index);
    if (action === "test-source") {
      if (index === null || !dataSources[index]) return realApi("/api/environment/test", { method: "POST", body: "{}" }).then(() => toast("Cube API 连通正常"));
      const source = dataSources[index];
      try {
        const result = await realApi("/api/datasources/test", { method: "POST", body: JSON.stringify({ name: source.name }) });
        source.status = "正常";
        source.checked = `刚刚 · ${result.durationMs} ms`;
        render();
        return toast(`连接成功，发现 ${result.databases} 个数据库`);
      } catch (error) {
        source.status = "异常";
        source.checked = "刚刚 · 连接失败";
        render();
        return toast(`连接失败：${compactRealError(error)}`);
      }
    }
    if (action === "delete-source") {
      const source = dataSources[index]; if (!source) return;
      let removed = false;
      return openModal({ title: `删除数据源“${source.name}”？`, sub: "确认后会自动删除并应用到 Cube。", icon: "!", confirm: "确认删除", body: `<label class="field">输入“${escapeHtml(source.name)}”确认<input id="deleteSourceConfirm"></label>`, onConfirm: async () => {
        if ($("#deleteSourceConfirm").value.trim() !== source.name) return toast("确认名称不一致");
        setModalBusy();
        try {
          if (!removed) {
            await realApi(`/api/datasources?name=${encodeURIComponent(source.name)}`, { method: "DELETE" });
            removed = true;
          }
          await applyRealDatasources({ allowEmpty: true });
          closeModal();
          toast("数据源已删除并应用");
        } catch (error) {
          restoreModalActions("确认删除");
          toast(`删除或应用失败：${compactRealError(error)}`);
        }
      } });
    }
    if (action === "new-model") return realNewModelModal();
    if (action === "auto-model") return realAutoModelModal();
    if (action === "import-model") return chooseLocalFile(".yml,.yaml,text/yaml", previewModelImport);
    if (action === "export-model") return exportCurrentModel();
    if (action === "remodel-model") return realRemodelModel();
    if (action === "apply-models") {
      const pending = models.filter((model) => model.pending === true || model.status === "草稿");
      const draftNames = pending
        .filter((model) => model.status === "草稿")
        .map((model) => modelData[model.id]?.filename)
        .filter(Boolean);
      if (state.modelState === "dirty") return toast("请先保存当前模型修改");
      if (!pending.length) return toast("暂无待应用草稿");
      if (["saving", "applying"].includes(state.modelState)) return toast("模型操作进行中，请稍候");
      state.modelState = "applying";
      render();
      // 发布请求立即返回任务 ID，后台重建和健康检查由任务继续执行。
      void (async () => {
        try {
          const result = await realApi("/api/models/apply", {
            method: "POST",
            body: JSON.stringify({ names: draftNames })
          });
          await watchModelApply(result.job?.id, pending.length);
        } catch (error) {
          const current = currentModel();
          state.modelState = current?.pending || current?.status === "草稿" ? "saved" : "applied";
          render();
          toast(`批量应用失败：${compactRealError(error)}`);
        }
      })();
      return;
    }
    if (action === "discard-model") {
      await reloadCurrentRealModel();
      return toast("已放弃修改，恢复服务器版本");
    }
    if (action === "delete-model") {
      const model = currentModel();
      return openModal({ title: `删除语义模型“${model.name}”？`, sub: "文件会移入可恢复目录，并重启 Cube。", icon: "!", confirm: "确认删除", body: `<label class="field">输入模型标识“${escapeHtml(model.id)}”确认<input id="deleteModelConfirm"></label>`, onConfirm: async () => {
        if ($("#deleteModelConfirm").value.trim() !== model.id) return toast("确认名称不一致");
        const confirmButton = $("#modalConfirm");
        if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = "删除中…"; }
        try {
          const result = await realApi(`/api/models/${encodeURIComponent(currentModelData().filename)}`, { method: "DELETE" });
          closeModal();
          try { await refreshAndToast(result.warning || "模型已移入回收目录并从 Cube 卸载"); }
          catch (refreshError) { toast(`模型已删除，刷新失败：${compactRealError(refreshError)}`); }
        } catch (error) {
          closeModal();
          try { await loadRealData(); } catch (_) { /* 保留删除请求错误提示 */ }
          toast(`删除失败：${compactRealError(error)}`);
        }
      } });
    }
    if (action === "save-draft") return saveRealModel(false);
    if (action === "apply-model") return saveRealModel(true);
    if (action === "validate-model" || action === "validate-yaml" || action === "format-yaml") {
      const data = currentModelData(); const content = $("#yamlEditor")?.value || data.yaml;
      let result;
      try {
        checkCommonYamlMistakes(content);
        result = await realApi("/api/model-doc/validate", { method: "POST", body: JSON.stringify({ content }) });
      } catch (error) {
        const detail = compactRealError(error, "YAML 语法错误");
        return toast(action === "format-yaml" ? `格式化失败：${detail}` : `校验失败：${detail}`);
      }
      if (action === "format-yaml" && $("#yamlEditor")) { $("#yamlEditor").value = result.formatted; data.yaml = result.formatted; setModelState("dirty"); }
      return toast(action === "format-yaml" ? "YAML 已格式化，尚未保存" : `YAML 校验通过：${result.cubes.join("、")}`);
    }
    if (action === "new-term") return realTermModal();
    if (action === "edit-term") return realTermModal(index);
    if (action === "export-glossary") { await downloadProtected("/api/glossary/export", "cube-glossary.json", "application/json"); return toast("业务术语已导出"); }
    if (action === "choose-glossary-import") return $("#glossaryImportInput")?.click();
    if (action === "delete-term") return openModal({ title: `删除标准术语“${glossary[index][1]}”？`, sub: `其 ${termAliases(glossary[index]).length} 个别名将同时停止参与归一化。`, icon: "!", confirm: "确认删除", body: '<div class="soft-box red"><strong>操作会写入真实术语表</strong></div>', onConfirm: async () => { try { await realApi(`/api/glossary?standard=${encodeURIComponent(glossary[index][1])}`, { method: "DELETE" }); closeModal(); await refreshAndToast("业务术语已删除"); } catch (error) { toast(error.message); } } });
    if (action === "select-mcp-server") { state.mcpServer = element?.dataset.mcpServerId || ""; state.mcpTab = "overview"; return render(); }
    if (action === "mcp-tab") { state.mcpTab = element?.dataset.mcpTab || "overview"; return render(); }
    if (action === "new-mcp-server") return mcpServerModal();
    if (action === "edit-mcp-server") {
      const server = (runtime.mcpServers || []).find((item) => item.id === element?.dataset.mcpServerId);
      return server ? mcpServerModal(server) : toast("MCP Server 不存在");
    }
    if (action === "toggle-mcp-server") {
      const id = element?.dataset.mcpServerId; const server = (runtime.mcpServers || []).find((item) => item.id === id);
      if (!server) return toast("MCP Server 不存在");
      await realApi(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ enabled: !server.enabled }) });
      await loadRealData(); return toast(server.enabled ? "MCP Server 已停用" : "MCP Server 已启用");
    }
    if (action === "delete-mcp-server") {
      const id = element?.dataset.mcpServerId; const server = (runtime.mcpServers || []).find((item) => item.id === id);
      if (!server) return toast("MCP Server 不存在");
      return openModal({ title: `删除 MCP Server“${server.name}”？`, sub: "删除前必须先撤销该 Server 的全部有效密钥。", icon: "!", confirm: "确认删除", body: `<label class="field">输入 Server ID“${escapeHtml(id)}”确认<input id="deleteMcpServerConfirm"></label>`, onConfirm: async () => { if ($("#deleteMcpServerConfirm").value.trim() !== id) return toast("确认内容不正确"); try { await realApi(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" }); closeModal(); await loadRealData(); toast("MCP Server 已删除"); } catch (error) { toast(compactRealError(error)); } } });
    }
    if (action === "copy-mcp-endpoint") {
      const server = (runtime.mcpServers || []).find((item) => item.id === element?.dataset.mcpServerId);
      return copyText(mcpEndpoint(server), "MCP Endpoint 已复制");
    }
    if (action === "create-mcp-token") return openMcpTokenCreateModal(element?.dataset.mcpServerId);
    if (action === "delete-mcp-token") {
      const id = element?.dataset.tokenId; const serverId = element?.dataset.mcpServerId;
      if (!id || !serverId) return toast("密钥记录不存在");
      return openModal({ title: "撤销服务密钥？", sub: "撤销后，使用该密钥的客户端将立即无法访问此 MCP Server。", icon: "!", confirm: "确认撤销", body: '<div class="soft-box red"><strong>此操作不可恢复</strong></div>', onConfirm: async () => { try { await realApi(`/api/mcp-servers/${encodeURIComponent(serverId)}/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }); localStorage.setItem(REAL_JWT_TOKENS_KEY, JSON.stringify(localJwtTokens().filter((item) => item.id !== id))); runtime.jwtTokens = (runtime.jwtTokens || []).filter((item) => item.id !== id); closeModal(); render(); toast("密钥已撤销"); } catch (error) { toast(compactRealError(error)); } } });
    }
    if (action === "refresh" || action === "refresh-monitor") return refreshAndToast();
    if (action === "generate-token") return openTokenCreateModal();
    if (action === "copy-native-mcp") return copyText(runtime.info?.nativeMcp?.endpoint || new URL("/mcp", window.location.origin).href, "MCP Endpoint 已复制");
    if (action === "copy-generated-token") {
      const token = runtime.lastGeneratedToken?.token || "";
      if (!token) return toast("完整令牌已不在当前页面，请重新生成");
      copyText(token, "令牌已复制");
      if (element) {
        element.classList.add("copied");
        const previousTitle = element.title;
        element.title = "已复制";
        setTimeout(() => {
          element.classList.remove("copied");
          element.title = previousTitle || "复制完整令牌";
        }, 1800);
      }
      return;
    }
    if (action === "copy-jwt-token") {
      const token = runtimeJwtToken(element?.dataset.tokenId);
      if (!token) return toast("该记录没有保存完整令牌，请重新生成");
      copyText(token, "令牌已复制");
      if (element) {
        element.classList.add("copied");
        const previousTitle = element.title;
        element.title = "已复制";
        setTimeout(() => {
          element.classList.remove("copied");
          element.title = previousTitle || "复制完整密钥";
        }, 1800);
      }
      return;
    }
    if (action === "delete-jwt-token") {
      const id = element?.dataset.tokenId;
      const record = (runtime.jwtTokens || []).find((item) => item.id === id);
      if (!id || !record) return toast("令牌记录不存在");
      return openModal({ title: "撤销并删除令牌？", sub: "删除后将从令牌列表和当前浏览器中移除该记录。", icon: "!", confirm: "确认撤销", body: '<div class="soft-box red"><strong>该 JWT 将立即无法访问 CubeBuddy 原生 MCP。</strong><p class="muted" style="margin:7px 0 0;font-size:11px">直接交给 Cube Core 或旧 REST 客户端的 JWT 仍按签名和有效期工作；如需全部失效，请轮换 API 签名密钥。</p></div>', onConfirm: async () => { try { await realApi(`/api/jwt/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }); localStorage.setItem(REAL_JWT_TOKENS_KEY, JSON.stringify(localJwtTokens().filter((item) => item.id !== id))); runtime.jwtTokens = (runtime.jwtTokens || []).filter((item) => item.id !== id); if (runtime.lastGeneratedToken?.id === id) runtime.lastGeneratedToken = null; closeModal(); render(); toast("令牌已撤销并删除"); } catch (error) { toast(`撤销失败：${compactRealError(error)}`); } } });
    }
    if (action === "reveal-secret") { const result = await realApi("/api/env"); const secret = result.env?.CUBEJS_API_SECRET || "未配置"; return openModal({ title: "JWT 签名设置", sub: "全局 CUBEJS_API_SECRET · 用于签发所有 MCP Server 的服务密钥。", icon: "J", confirm: "关闭", body: `<div class="soft-box orange"><strong>全局生效</strong><p class="muted" style="margin:7px 0 0">轮换后，所有 MCP Server 的现有 JWT 都会失效，并需要重新签发。</p></div><div class="secret" style="margin-top:14px;word-break:break-all">${escapeHtml(secret)}</div><div class="actions" style="margin-top:12px"><button class="btn small" data-action="copy-modal-secret">复制密钥</button><button class="btn small danger" data-action="rotate-secret">轮换签名密钥</button></div>` }); }
    if (action === "copy-modal-secret") return copyText($("#modalBody .secret")?.textContent || "", "密钥已复制");
    if (action === "rotate-secret") return openModal({ title: "轮换 API 签名密钥", sub: "现有 JWT 会立即失效。", icon: "!", confirm: "确认轮换", body: '<label class="field">输入“轮换密钥”确认<input id="rotateConfirm"></label>', onConfirm: async () => { if ($("#rotateConfirm").value.trim() !== "轮换密钥") return toast("确认文字不正确"); try { await realApi("/api/rotate-secret", { method: "POST", body: "{}" }); closeModal(); toast("密钥已轮换，请应用环境并重新签发 JWT"); } catch (error) { toast(error.message); } } });
    if (action === "copy-spec-url") return copyText(new URL("/openapi.yaml", window.location.origin).href, "Spec URL 已复制");
    if (action === "open-tool-detail") return openToolDrawer(element?.dataset.toolName);
    if (action === "update-openapi-tools") {
      const result = await realApi("/api/tools/refresh", { method: "POST", body: "{}" });
      coreTools.splice(0, coreTools.length, ...(result.cubeCore || []));
      runtime.openapiSchemas = result.openapiSchemas && typeof result.openapiSchemas === "object" ? result.openapiSchemas : {};
      runtime.toolsUpdatedAt = result.updatedAt || "";
      render();
      return toast(`已读取静态 openapi.yaml，更新 ${coreTools.length} 个工具`);
    }
    if (action === "view-openapi-yaml") {
      const result = await realApi("/api/openapi/source");
      const modified = new Date(result.mtime).toLocaleString("zh-CN", { hour12: false });
      return openModal({ title: "openapi.yaml", sub: `${result.name} · ${(result.size / 1024).toFixed(1)} KB · 更新于 ${modified}`, icon: "Y", wide: true, confirm: "关闭", body: `<pre class="openapi-viewer">${escapeHtml(result.content || "")}</pre>` });
    }
    if (action === "import-openapi") return chooseLocalFile(".yml,.yaml,text/yaml", previewOpenApiImport);
    if (action === "export-openapi") { await downloadProtected("/api/openapi", "openapi.yaml", "application/yaml"); return toast("openapi.yaml 已导出"); }
    if (action === "download-openapi") { await downloadProtected("/api/openapi", "openapi.yaml", "application/yaml"); return toast("openapi.yaml 已下载"); }
    if (action === "download-logs") { const text = rawLogs.map((line) => line[2]).join("\n"); const blob = new Blob([text], { type: "text/plain" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `cube-api-${Date.now()}.log`; link.click(); URL.revokeObjectURL(url); return; }
    if (action === "save-environment") { const result = await realApi("/api/environment", { method: "PUT", body: JSON.stringify({ environment: environmentConfig }) }); Object.assign(environmentConfig, result.environment); state.environmentDirty = false; render(); return toast("环境设置已保存"); }
    if (action === "test-environment") { await realApi("/api/environment/test", { method: "POST", body: "{}" }); return toast("部署目录与 Cube API 连通正常"); }
    return handleUiAction(action, element);
  } catch (error) { toast(`操作失败：${error.message}`); }
};

function openQueryDrawer() {
  const model = currentModel(); const data = currentModelData();
  drawerLastFocused = document.activeElement; runtime.query = null; runtime.queryError = ""; state.queryStatus = "idle"; state.queryOutputTab = "result";
  $("#drawerTitle").textContent = `测试查询 · ${model.name}`;
  $("#drawerSub").textContent = `${model.id} · 直接请求真实 Cube API`;
  $("#drawerBody").innerHTML = `<div class="query-config"><div class="toolbar"><div><strong>查询成员</strong><small style="display:block">请选择实际模型中的指标和维度</small></div>${badge("真实环境")}</div><div class="grid cols-2"><div><h3 class="section-title">指标</h3><div class="query-member-grid">${data.metrics.map((item, i) => `<label class="member-choice"><input class="query-member" data-kind="measure" value="${escapeHtml(model.id + "." + item.name)}" type="checkbox" ${i === 0 ? "checked" : ""}> ${escapeHtml(item.title)}</label>`).join("") || "暂无指标"}</div></div><div><h3 class="section-title">维度</h3><div class="query-member-grid">${data.dimensions.map((item) => `<label class="member-choice"><input class="query-member" data-kind="dimension" value="${escapeHtml(model.id + "." + item.name)}" type="checkbox"> ${escapeHtml(item.title)}</label>`).join("") || "暂无维度"}</div></div></div></div><div class="query-config"><label class="field">返回行数<select id="queryLimit"><option>100</option><option>500</option><option>1000</option></select></label></div>`;
  $("#queryOutput").innerHTML = queryOutputContent();
  $("#queryDrawer").classList.add("show"); $("#drawerBackdrop").classList.add("show"); updateQueryRunState();
};

function buildRealQuery() {
  const measures = $$('.query-member[data-kind="measure"]:checked', $("#queryDrawer")).map((item) => item.value);
  const dimensions = $$('.query-member[data-kind="dimension"]:checked', $("#queryDrawer")).map((item) => item.value);
  return { measures, dimensions, limit: Number($("#queryLimit")?.value) || 100 };
}

function queryOutputContent() {
  if (state.queryStatus === "idle") return '<div class="query-config"><div class="query-empty"><b>准备运行真实查询</b><span>选择成员后点击“运行查询”。</span></div></div>';
  if (state.queryStatus === "loading") return '<div class="query-config"><div class="query-empty"><div class="loading-ring"></div><b>正在请求 Cube</b></div></div>';
  if (state.queryStatus === "error") return `<div class="query-config"><div class="query-error"><strong>查询失败</strong><br>${escapeHtml(runtime.queryError)}</div></div>`;
  const response = runtime.query; const load = response?.load; const result = load?.data?.results?.[0] || load?.data;
  const rows = result?.data || [];
  const summary = `<div class="query-summary"><div><strong>查询成功 · ${load?.durationMs || 0} ms · ${rows.length} 行</strong></div><span class="cache-pill">真实 Cube API</span></div>`;
  if (state.queryOutputTab === "json") return `<div class="query-config">${summary}${queryOutputTabs()}<pre class="code-panel">${escapeHtml(JSON.stringify(response.query, null, 2))}</pre></div>`;
  if (state.queryOutputTab === "sql") return `<div class="query-config">${summary}${queryOutputTabs()}<pre class="code-panel">${escapeHtml(JSON.stringify(response.sql?.data || {}, null, 2))}</pre></div>`;
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return `<div class="query-config">${summary}${queryOutputTabs()}${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, 100).map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : '<div class="empty"><b>查询成功，没有返回数据</b></div>'}</div>`;
};

$("#queryDrawer").onclick = async (event) => {
  const tab = event.target.closest("[data-query-tab]"); if (tab) { state.queryOutputTab = tab.dataset.queryTab; renderQueryOutput(); return; }
  const button = event.target.closest("[data-drawer-action]"); if (!button) { if (event.target.matches(".query-member")) updateQueryRunState(); return; }
  try {
    const query = buildRealQuery();
    if (!query.measures.length && !query.dimensions.length) return toast("请至少选择一个查询成员");
    if (button.dataset.drawerAction === "dry-run") { await realApi("/api/query/dry-run", { method: "POST", body: JSON.stringify({ query }) }); return toast("真实 dry-run 校验通过"); }
    if (button.dataset.drawerAction === "run") { state.queryStatus = "loading"; renderQueryOutput(); try { runtime.query = await realApi("/api/query", { method: "POST", body: JSON.stringify({ query }) }); state.queryStatus = "success"; } catch (error) { runtime.queryError = error.message; state.queryStatus = "error"; } renderQueryOutput(); updateQueryRunState(); }
  } catch (error) { toast(error.message); }
};

$("#loginBtn").onclick = async () => {
  const token = $("#loginToken").value.trim();
  if (!token) return showRealLogin("请输入管理员令牌");
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (!response.ok) throw new Error("令牌错误");
    localStorage.setItem(REAL_TOKEN_KEY, token); $("#loginScreen").classList.remove("show");
    await loadRealData({ keepPage: false }); toast("已接入真实 Cube 生产环境");
  } catch (error) { showRealLogin(`登录失败：${error.message}`); }
};
$("#loginToken").onkeydown = (event) => { if (event.key === "Enter") $("#loginBtn").click(); };
$("#logoutBtn").onclick = () => { localStorage.removeItem(REAL_TOKEN_KEY); $("#loginToken").value = ""; showRealLogin("已安全退出"); };
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#toolCatalogDrawer")?.classList.contains("show")) closeToolDrawer();
});

(async function bootstrapRealConsole() {
  if (!localStorage.getItem(REAL_TOKEN_KEY)) return showRealLogin();
  try { await loadRealData(); $("#loginScreen").classList.remove("show"); }
  catch (error) { showRealLogin(`连接真实环境失败：${error.message}`); }
})();
