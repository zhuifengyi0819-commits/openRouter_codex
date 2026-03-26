import type { GatewayRuntime } from "../core/runtime.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderAdminPage(runtime: GatewayRuntime, setupToken: string): string {
  const config = runtime.getConfig();
  const oauthDefaults = config.oauthConnectDefaults;
  const persistedState = runtime.getPersistedState();
  const oauthCallbackDisplay = `http://localhost:${config.oauthCallbackPort}${config.oauthCallbackPath} -> gateway ${config.oauthCallbackPath}`;
  const initialPayload = {
    config: {
      upstreams: config.upstreams.map((upstream) => ({
        id: upstream.id,
        kind: upstream.kind,
        baseUrl: upstream.baseUrl,
        openaiMode: upstream.openaiMode ?? "platform",
        authMode: upstream.authMode ?? "api_key",
        authHeader: upstream.authHeader ?? (upstream.kind === "anthropic" ? "x-api-key" : "authorization_bearer"),
        enabled: upstream.enabled !== false,
        models: upstream.models ?? [],
        headers: upstream.headers ?? {},
        cooldownMs: upstream.cooldownMs ?? 30000,
        timeoutMs: upstream.timeoutMs ?? config.requestTimeoutMs
      })),
      workspaces: config.workspaces.map((workspace) => ({
        id: workspace.id,
        upstreamIds: workspace.upstreamIds ?? [],
        modelMap: workspace.modelMap ?? {},
        enabled: workspace.enabled !== false,
        isDefault: workspace.isDefault === true
      })),
      oauthDefaults: {
        baseUrl: oauthDefaults?.baseUrl ?? "",
        authorizationUrl: oauthDefaults?.authorizationUrl ?? "",
        tokenUrl: oauthDefaults?.tokenUrl ?? "",
        authorizeExtraParams: oauthDefaults?.authorizeExtraParams ?? {}
      },
      oauthCallbackPath: config.oauthCallbackPath
    },
    storage: runtime.getStoragePaths(),
    persisted: {
      upstreamIds: persistedState.upstreams.map((item) => item.id),
      workspaceIds: persistedState.workspaces.map((item) => item.id),
      upstreamCount: persistedState.upstreams.length,
      workspaceCount: persistedState.workspaces.length
    },
    workspaces: runtime.getGateway().getWorkspaceSummaries(),
    runtime: runtime.getRuntimeSummary()
  };

  const oauthExtraDefault = Object.keys(initialPayload.config.oauthDefaults.authorizeExtraParams).length > 0
    ? JSON.stringify(initialPayload.config.oauthDefaults.authorizeExtraParams, null, 2)
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gateway Admin</title>
    <style>
      :root {
        --bg: #f3efe8;
        --panel: rgba(255, 252, 246, 0.94);
        --panel-strong: #fffdfa;
        --line: #d8cec1;
        --ink: #201b16;
        --muted: #6f665c;
        --accent: #0f766e;
        --accent-soft: rgba(15, 118, 110, 0.12);
        --warn: #b45309;
        --warn-soft: rgba(180, 83, 9, 0.12);
        --danger: #b42318;
        --danger-soft: rgba(180, 35, 24, 0.12);
        --shadow: rgba(32, 27, 22, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.18), transparent 20rem),
          radial-gradient(circle at top right, rgba(180, 83, 9, 0.10), transparent 24rem),
          linear-gradient(180deg, #fbfaf7, var(--bg));
      }
      main {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 18px 64px;
        display: grid;
        gap: 18px;
      }
      h1, h2, h3 {
        margin: 0;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      .hero, .section, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 14px 34px var(--shadow);
      }
      .hero, .section {
        padding: 20px;
      }
      .hero-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: 1.25fr 0.75fr;
      }
      .title {
        display: grid;
        gap: 8px;
      }
      .eyebrow {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero h1 {
        font-size: 34px;
        line-height: 1.08;
      }
      .mono-block {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        line-height: 1.5;
        color: var(--muted);
        background: #f4eee5;
        border-radius: 14px;
        padding: 14px;
      }
      .feedback {
        display: none;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        font-size: 14px;
      }
      .feedback.visible {
        display: block;
      }
      .feedback.info {
        background: #eef7f6;
        border-color: rgba(15, 118, 110, 0.22);
        color: #0b5f59;
      }
      .feedback.success {
        background: #edf8f3;
        border-color: rgba(15, 118, 110, 0.24);
        color: #0d5a46;
      }
      .feedback.error {
        background: #fff4f2;
        border-color: rgba(180, 35, 24, 0.24);
        color: #8d2018;
      }
      .feedback.warn {
        background: #fff8ef;
        border-color: rgba(180, 83, 9, 0.22);
        color: #9a4b06;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .toolbar-grow {
        flex: 1 1 auto;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 16px;
      }
      .section-head-copy {
        display: grid;
        gap: 6px;
      }
      .stats-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .stat {
        background: var(--panel-strong);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px;
      }
      .stat-label {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .stat-value {
        margin-top: 8px;
        font-size: 30px;
        line-height: 1.1;
      }
      .stat-note {
        margin-top: 8px;
        font-size: 13px;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .filters select,
      .filters button,
      .filters label {
        margin: 0;
      }
      .filters input[type="search"] {
        width: 240px;
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
      }
      table {
        width: 100%;
        min-width: 1080px;
        border-collapse: collapse;
      }
      table.teams-table {
        min-width: 1180px;
        table-layout: fixed;
      }
      table.teams-table th:nth-child(1),
      table.teams-table td:nth-child(1) {
        width: 24%;
      }
      table.teams-table th:nth-child(2),
      table.teams-table td:nth-child(2) {
        width: 18%;
      }
      table.teams-table th:nth-child(3),
      table.teams-table td:nth-child(3) {
        width: 14%;
      }
      table.teams-table th:nth-child(4),
      table.teams-table td:nth-child(4) {
        width: 12%;
      }
      table.teams-table th:nth-child(5),
      table.teams-table td:nth-child(5) {
        width: 12%;
      }
      table.teams-table th:nth-child(6),
      table.teams-table td:nth-child(6) {
        width: 20%;
      }
      table.teams-table td {
        word-break: break-word;
      }
      th, td {
        border-bottom: 1px solid rgba(216, 206, 193, 0.85);
        padding: 12px 14px;
        vertical-align: top;
        text-align: left;
        font-size: 14px;
      }
      th {
        background: #f3ede4;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      tbody tr:hover {
        background: rgba(15, 118, 110, 0.05);
      }
      tbody tr.team-row-danger {
        background: rgba(180, 35, 24, 0.08);
      }
      tbody tr.team-row-warn {
        background: rgba(180, 83, 9, 0.08);
      }
      tbody tr.team-row-muted {
        background: rgba(111, 102, 92, 0.08);
      }
      .cell-strong {
        color: var(--ink);
        font-weight: 700;
      }
      .cell-meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .status-text {
        margin-top: 8px;
        font-size: 13px;
        font-weight: 700;
      }
      .status-text.ok {
        color: #0d5a46;
      }
      .status-text.warn {
        color: #9a4b06;
      }
      .status-text.danger {
        color: #8d2018;
      }
      .status-text.muted {
        color: var(--muted);
      }
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .badge-row, .action-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .badge {
        display: inline-block;
        padding: 3px 9px;
        border-radius: 999px;
        background: #e8ded1;
        color: var(--ink);
        font-size: 12px;
      }
      .badge.ok {
        background: var(--accent);
        color: #ecfeff;
      }
      .badge.warn {
        background: var(--warn-soft);
        color: var(--warn);
      }
      .badge.danger {
        background: var(--danger-soft);
        color: var(--danger);
      }
      button,
      select,
      input,
      textarea {
        font: inherit;
      }
      button,
      .button-link {
        border: none;
        border-radius: 999px;
        padding: 9px 14px;
        cursor: pointer;
        background: var(--accent);
        color: #ecfeff;
      }
      button.secondary,
      .button-link.secondary {
        background: #e8ded1;
        color: var(--ink);
      }
      button.warn {
        background: var(--warn);
      }
      button.danger {
        background: var(--danger);
      }
      button:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      .checkbox {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        color: var(--muted);
      }
      .checkbox input {
        width: auto;
        margin: 0;
      }
      select,
      input,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: white;
        color: var(--ink);
      }
      textarea {
        min-height: 88px;
        resize: vertical;
      }
      .form-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .field {
        display: grid;
        gap: 6px;
      }
      .field.span-2 {
        grid-column: span 2;
      }
      .form-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      details.panel {
        overflow: hidden;
      }
      details.panel > summary {
        cursor: pointer;
        list-style: none;
        padding: 16px 18px;
        font-weight: 700;
      }
      details.panel > summary::-webkit-details-marker {
        display: none;
      }
      details.panel[open] > summary {
        border-bottom: 1px solid var(--line);
      }
      .panel-body {
        padding: 18px;
      }
      .helper {
        color: var(--muted);
        font-size: 13px;
      }
      .empty {
        padding: 16px;
        color: var(--muted);
      }
      .modal {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(32, 27, 22, 0.34);
        z-index: 40;
      }
      .modal.open {
        display: flex;
      }
      .modal-card {
        width: min(820px, 100%);
        max-height: calc(100vh - 48px);
        overflow: auto;
        background: var(--panel-strong);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 24px 50px rgba(32, 27, 22, 0.18);
        padding: 20px;
        display: grid;
        gap: 16px;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      @media (max-width: 980px) {
        .hero-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-grid">
          <div class="title">
            <div class="eyebrow">Gateway Admin</div>
            <h1>Teams, Workspaces, Runtime</h1>
            <p>统一在这个页面里连接 Codex Team、查看状态、管理 workspace 和排查失败请求，不再拆成命令行和网页两套入口。</p>
            <div class="hero-actions">
              <button id="connect-codex-team" type="button">Connect Codex Team</button>
              <button id="refresh-page" type="button" class="secondary">Refresh</button>
              <span class="helper">点击后会打开 OpenAI 登录页。已有 team 时会强制重新认证，方便切换组织。</span>
            </div>
          </div>
          <div class="mono-block">Data dir: ${escapeHtml(initialPayload.storage.dataDir)}
Encrypted state: ${escapeHtml(initialPayload.storage.statePath)}
Stored upstreams: ${initialPayload.persisted.upstreamCount}
Stored workspaces: ${initialPayload.persisted.workspaceCount}
OAuth callback: ${escapeHtml(oauthCallbackDisplay)}</div>
        </div>
      </section>

      <section class="section">
        <div id="feedback" class="feedback">Ready.</div>
      </section>

      <section class="section">
        <div class="section-head">
          <div class="section-head-copy">
            <h2>Dashboard</h2>
            <p>查看 team 可用性、请求量、延时和 token 用量。所有操作都会在这里给出明确反馈。</p>
          </div>
          <div class="filters">
            <select id="workspace-filter">
              <option value="__all__">All Workspaces</option>
            </select>
            <input id="team-search" type="search" placeholder="Search team, workspace, model..." />
            <select id="team-sort">
              <option value="requests_desc">Sort By Requests</option>
              <option value="latency_desc">Sort By Latency</option>
              <option value="tokens_desc">Sort By Tokens</option>
              <option value="errors_desc">Sort By Failures</option>
              <option value="name_asc">Sort By Name</option>
            </select>
            <select id="team-attention-filter">
              <option value="all">All Status</option>
              <option value="attention">Needs Attention</option>
              <option value="failed">Failed</option>
              <option value="disabled">Disabled</option>
              <option value="cooling">Cooling Down</option>
            </select>
            <button id="team-attention-workspace" type="button" class="secondary">Attention Here</button>
          </div>
        </div>
        <div id="summary-cards" class="stats-grid"></div>
        <p id="summary-meta" class="helper">Loading...</p>
        <details class="panel" style="margin-top: 14px;">
          <summary>Tools</summary>
          <div class="panel-body">
            <div class="filters">
              <label class="checkbox"><input id="auto-refresh" type="checkbox" checked /> Auto refresh 10s</label>
              <button id="export-json" type="button" class="secondary">Export JSON</button>
              <button id="export-csv" type="button" class="secondary">Export CSV</button>
            </div>
          </div>
        </details>
      </section>

      <section class="section">
        <div class="section-head">
          <div class="section-head-copy">
            <h2>Teams</h2>
            <p>失败、冷却、禁用的 team 会直接用颜色区分。连接新 team、刷新同一个 team 的认证，都从顶部按钮进入。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="teams-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Status</th>
                <th>Requests</th>
                <th>Latency</th>
                <th>Usage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="teams-body">
              <tr><td colspan="6" class="empty">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div class="section-head-copy">
            <h2>Workspaces</h2>
            <p>管理路由分组和默认 workspace，不再单独拆成卡片。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Routing</th>
                <th>Models</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="workspaces-body">
              <tr><td colspan="4" class="empty">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <details class="panel">
        <summary>Manual Setup & Advanced</summary>
        <div class="panel-body stack">
          <p class="helper">日常只需要顶部的 <code>Connect Codex Team</code>。下面这些表单保留给 API key、workspace 和兼容 OAuth 的手工接入。</p>

          <details class="panel">
            <summary>OpenAI API Key</summary>
            <div class="panel-body">
          <form id="openai-api-key-form" class="stack">
            <div class="form-grid">
              <label class="field">Upstream ID <input name="id" placeholder="openai-primary" required /></label>
              <label class="field">Base URL <input name="baseUrl" placeholder="https://api.openai.com" required /></label>
              <label class="field span-2">API Key <input name="apiKey" type="password" required /></label>
              <label class="field">Models <textarea name="models" placeholder="gpt-4.1,gpt-4.1-mini"></textarea></label>
              <label class="field">Headers JSON <textarea name="headers" placeholder='{"OpenAI-Organization":"org_..."}'></textarea></label>
            </div>
            <div class="form-actions">
              <label class="checkbox"><input type="checkbox" name="enabled" checked /> Enabled</label>
              <button type="submit">Save OpenAI Upstream</button>
            </div>
          </form>
            </div>
          </details>

          <details class="panel">
            <summary>Anthropic API Key</summary>
            <div class="panel-body">
          <form id="anthropic-api-key-form" class="stack">
            <div class="form-grid">
              <label class="field">Upstream ID <input name="id" placeholder="anthropic-primary" required /></label>
              <label class="field">Base URL <input name="baseUrl" placeholder="https://api.anthropic.com" required /></label>
              <label class="field span-2">API Key <input name="apiKey" type="password" required /></label>
              <label class="field">Models <textarea name="models" placeholder="claude-3-7-sonnet-latest"></textarea></label>
              <label class="field">Headers JSON <textarea name="headers" placeholder='{"anthropic-beta":"..."}'></textarea></label>
            </div>
            <div class="form-actions">
              <label class="checkbox"><input type="checkbox" name="enabled" checked /> Enabled</label>
              <button type="submit">Save Anthropic Upstream</button>
            </div>
          </form>
            </div>
          </details>

          <details class="panel">
            <summary>Workspace</summary>
            <div class="panel-body">
          <form id="workspace-form" class="stack">
            <div class="form-grid">
              <label class="field">Workspace ID <input name="id" placeholder="team-a" required /></label>
              <label class="field">Allowed Upstream IDs <input name="upstreamIds" placeholder="codex-team-a,openai-primary" /></label>
              <label class="field span-2">Model Map JSON <textarea name="modelMap" placeholder='{"gpt-5":"gpt-5.4"}'></textarea></label>
            </div>
            <div class="form-actions">
              <label class="checkbox"><input type="checkbox" name="enabled" checked /> Enabled</label>
              <label class="checkbox"><input type="checkbox" name="isDefault" /> Default Workspace</label>
              <button type="submit">Save Workspace</button>
            </div>
          </form>
            </div>
          </details>

          <details class="panel">
            <summary>Advanced OAuth</summary>
            <div class="panel-body">
          <p class="helper">这里只给真正支持标准兼容 API 的 OAuth provider 用。Codex / ChatGPT team 请用顶部的 <code>Connect Codex Team</code> 按钮。</p>
          <div class="form-grid" style="margin-top: 14px;">
            <form id="oauth-openai-form" class="stack">
              <h3>OAuth OpenAI-Compatible</h3>
              <label class="field">Upstream ID <input name="id" placeholder="oauth-openai-provider" required /></label>
              <label class="field">Base URL <input name="baseUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.baseUrl)}" required /></label>
              <label class="field">Authorization URL <input name="authorizationUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.authorizationUrl)}" required /></label>
              <label class="field">Token URL <input name="tokenUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.tokenUrl)}" required /></label>
              <label class="field">Client ID <input name="clientId" required /></label>
              <label class="field">Client Secret <input name="clientSecret" type="password" required /></label>
              <label class="field">Scopes <input name="scopes" placeholder="openid profile email offline_access" /></label>
              <label class="field">Models <textarea name="models" placeholder="model-a,model-b"></textarea></label>
              <label class="field">Headers JSON <textarea name="headers" placeholder='{"x-tenant":"foo"}'></textarea></label>
              <label class="field">Authorize Extra JSON <textarea name="authorizeExtraParams">${escapeHtml(oauthExtraDefault)}</textarea></label>
              <label class="field">Auth Header
                <select name="authHeader">
                  <option value="authorization_bearer">Authorization: Bearer</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </label>
              <div class="form-actions">
                <label class="checkbox"><input type="checkbox" name="enabled" checked /> Enabled</label>
                <button type="submit">Start OAuth</button>
              </div>
            </form>

            <form id="oauth-anthropic-form" class="stack">
              <h3>OAuth Anthropic-Compatible</h3>
              <label class="field">Upstream ID <input name="id" placeholder="oauth-anthropic-provider" required /></label>
              <label class="field">Base URL <input name="baseUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.baseUrl)}" required /></label>
              <label class="field">Authorization URL <input name="authorizationUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.authorizationUrl)}" required /></label>
              <label class="field">Token URL <input name="tokenUrl" value="${escapeHtml(initialPayload.config.oauthDefaults.tokenUrl)}" required /></label>
              <label class="field">Client ID <input name="clientId" required /></label>
              <label class="field">Client Secret <input name="clientSecret" type="password" required /></label>
              <label class="field">Scopes <input name="scopes" placeholder="openid profile api" /></label>
              <label class="field">Models <textarea name="models" placeholder="claude-like-model"></textarea></label>
              <label class="field">Headers JSON <textarea name="headers" placeholder='{"x-tenant":"foo"}'></textarea></label>
              <label class="field">Authorize Extra JSON <textarea name="authorizeExtraParams">${escapeHtml(oauthExtraDefault)}</textarea></label>
              <label class="field">Auth Header
                <select name="authHeader">
                  <option value="authorization_bearer">Authorization: Bearer</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </label>
              <div class="form-actions">
                <label class="checkbox"><input type="checkbox" name="enabled" checked /> Enabled</label>
                <button type="submit">Start OAuth</button>
              </div>
            </form>
          </div>
            </div>
          </details>
        </div>
      </details>

      <div id="team-detail-modal" class="modal">
        <div class="modal-card">
          <div class="modal-head">
            <div class="section-head-copy">
              <h2 id="team-detail-title">Team Detail</h2>
              <p id="team-detail-subtitle" class="helper"></p>
            </div>
            <button id="close-team-detail" type="button" class="secondary">Close</button>
          </div>
          <div id="team-detail-body" class="stack"></div>
        </div>
      </div>

      <div id="team-edit-modal" class="modal">
        <div class="modal-card">
          <div class="modal-head">
            <div class="section-head-copy">
              <h2 id="team-edit-title">Edit Team</h2>
              <p class="helper">Secrets stay on the server. Leave secret fields empty to preserve the current value.</p>
            </div>
            <button id="close-team-edit" type="button" class="secondary">Close</button>
          </div>
          <form id="team-edit-form" class="stack">
            <input type="hidden" name="id" />
            <div class="form-grid">
              <label class="field">Base URL <input name="baseUrl" required /></label>
              <label class="field">Auth Header
                <select name="authHeader">
                  <option value="authorization_bearer">Authorization: Bearer</option>
                  <option value="x-api-key">x-api-key</option>
                </select>
              </label>
              <label class="field">Cooldown Ms <input name="cooldownMs" type="number" min="0" /></label>
              <label class="field">Timeout Ms <input name="timeoutMs" type="number" min="1" /></label>
              <label class="field span-2">Models <textarea name="models" placeholder="gpt-5.4,gpt-5.4-mini"></textarea></label>
              <label class="field span-2">Headers JSON <textarea name="headers" placeholder='{"x-tenant":"foo"}'></textarea></label>
              <label class="field span-2" id="team-edit-api-key-field">Replace API Key <input name="apiKey" type="password" placeholder="leave empty to keep current key" /></label>
            </div>
            <div class="form-actions">
              <label class="checkbox"><input type="checkbox" name="enabled" /> Enabled</label>
              <button type="submit">Save Team</button>
            </div>
          </form>
        </div>
      </div>

      <div id="workspace-edit-modal" class="modal">
        <div class="modal-card">
          <div class="modal-head">
            <div class="section-head-copy">
              <h2 id="workspace-edit-title">Edit Workspace</h2>
              <p class="helper">修改路由绑定、模型别名和默认 workspace。</p>
            </div>
            <button id="close-workspace-edit" type="button" class="secondary">Close</button>
          </div>
          <form id="workspace-edit-form" class="stack">
            <input type="hidden" name="id" />
            <div class="form-grid">
              <label class="field">Allowed Upstream IDs <input name="upstreamIds" /></label>
              <label class="field span-2">Model Map JSON <textarea name="modelMap"></textarea></label>
            </div>
            <div class="form-actions">
              <label class="checkbox"><input type="checkbox" name="enabled" /> Enabled</label>
              <label class="checkbox"><input type="checkbox" name="isDefault" /> Default Workspace</label>
              <button type="submit">Save Workspace</button>
            </div>
          </form>
        </div>
      </div>
    </main>

    <script>
      const setupToken = ${serializeForInlineScript(setupToken)};
      const initialPayload = ${serializeForInlineScript(initialPayload)};

      const feedbackNode = document.getElementById("feedback");
      const connectCodexTeamButtonNode = document.getElementById("connect-codex-team");
      const summaryCardsNode = document.getElementById("summary-cards");
      const summaryMetaNode = document.getElementById("summary-meta");
      const teamsBodyNode = document.getElementById("teams-body");
      const workspacesBodyNode = document.getElementById("workspaces-body");
      const workspaceFilterNode = document.getElementById("workspace-filter");
      const teamSearchNode = document.getElementById("team-search");
      const teamSortNode = document.getElementById("team-sort");
      const teamAttentionFilterNode = document.getElementById("team-attention-filter");
      const teamAttentionWorkspaceButtonNode = document.getElementById("team-attention-workspace");
      const autoRefreshNode = document.getElementById("auto-refresh");
      const teamDetailModalNode = document.getElementById("team-detail-modal");
      const teamDetailTitleNode = document.getElementById("team-detail-title");
      const teamDetailSubtitleNode = document.getElementById("team-detail-subtitle");
      const teamDetailBodyNode = document.getElementById("team-detail-body");
      const teamEditModalNode = document.getElementById("team-edit-modal");
      const teamEditFormNode = document.getElementById("team-edit-form");
      const teamEditApiKeyFieldNode = document.getElementById("team-edit-api-key-field");
      const workspaceEditModalNode = document.getElementById("workspace-edit-modal");
      const workspaceEditFormNode = document.getElementById("workspace-edit-form");

      let pageState = initialPayload;
      let refreshTimer;
      const latestHealthByUpstreamId = {};
      const uiPrefsKey = "gateway-admin-ui-prefs";

      function escapeHtmlClient(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function showFeedback(message, kind = "info") {
        feedbackNode.className = "feedback visible " + kind;
        feedbackNode.textContent = message;
      }

      function loadUiPrefs() {
        try {
          const raw = window.localStorage.getItem(uiPrefsKey);
          if (!raw) {
            return {};
          }
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          return {};
        }
      }

      function saveUiPrefs() {
        try {
          window.localStorage.setItem(uiPrefsKey, JSON.stringify({
            workspaceFilter: workspaceFilterNode.value,
            teamSearch: teamSearchNode.value,
            teamSort: teamSortNode.value,
            teamAttentionFilter: teamAttentionFilterNode.value,
            autoRefresh: autoRefreshNode.checked
          }));
        } catch {
          // ignore storage failures
        }
      }

      function applyUiPrefs() {
        const prefs = loadUiPrefs();
        if (typeof prefs.teamSearch === "string") {
          teamSearchNode.value = prefs.teamSearch;
        }
        if (typeof prefs.teamSort === "string") {
          teamSortNode.value = prefs.teamSort;
        }
        if (typeof prefs.teamAttentionFilter === "string") {
          teamAttentionFilterNode.value = prefs.teamAttentionFilter;
        }
        if (typeof prefs.autoRefresh === "boolean") {
          autoRefreshNode.checked = prefs.autoRefresh;
        }
      }

      function formatDurationMs(value, fractionDigits = 0) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return "n/a";
        }
        if (value < 1000) {
          return value.toFixed(fractionDigits) + " ms";
        }
        return (value / 1000).toFixed(2) + " s";
      }

      function formatTimestamp(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return "never";
        }
        return new Date(value).toLocaleString("zh-CN", { hour12: false });
      }

      function formatNumber(value, fractionDigits = 0) {
        return typeof value === "number" && Number.isFinite(value) ? value.toFixed(fractionDigits) : "n/a";
      }

      function renderBadge(label, kind = "") {
        return '<span class="badge ' + kind + '">' + escapeHtmlClient(label) + "</span>";
      }

      function parseJsonOrDefault(value, fallback) {
        if (!value || !value.trim()) {
          return fallback;
        }
        return JSON.parse(value);
      }

      function splitCsv(value) {
        return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
      }

      function splitScopes(value) {
        return String(value || "").split(/\\s+/).map((item) => item.trim()).filter(Boolean);
      }

      function parseAuthorizeExtraParams(form) {
        const raw = String(form.get("authorizeExtraParams") || "").trim();
        if (!raw) {
          return undefined;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Authorize extra query must be a JSON object");
        }
        const output = {};
        Object.entries(parsed).forEach(([key, value]) => {
          if (value === undefined || value === null) {
            return;
          }
          output[key] = typeof value === "string" ? value : String(value);
        });
        return Object.keys(output).length > 0 ? output : undefined;
      }

      async function request(url, options = {}) {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...(options.headers || {}),
            "x-setup-token": setupToken
          }
        });

        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }

        if (!response.ok) {
          throw new Error(payload.message || payload.raw || text || "Request failed");
        }

        return payload;
      }

      async function postJson(url, payload) {
        return request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      }

      async function deleteRequest(url) {
        return request(url, { method: "DELETE" });
      }

      function getWorkspaceOptions(payload) {
        return Array.isArray(payload.workspaces) ? payload.workspaces : [];
      }

      function normalizePayload(raw) {
        if (raw && raw.persisted) {
          return raw;
        }

        return {
          config: {
            upstreams: Array.isArray(raw && raw.config && raw.config.upstreams) ? raw.config.upstreams : [],
            workspaces: Array.isArray(raw && raw.config && raw.config.workspaces) ? raw.config.workspaces : [],
            oauthDefaults: {
              baseUrl: raw && raw.config && raw.config.oauthConnectDefaults ? raw.config.oauthConnectDefaults.baseUrl || "" : "",
              authorizationUrl: raw && raw.config && raw.config.oauthConnectDefaults ? raw.config.oauthConnectDefaults.authorizationUrl || "" : "",
              tokenUrl: raw && raw.config && raw.config.oauthConnectDefaults ? raw.config.oauthConnectDefaults.tokenUrl || "" : "",
              authorizeExtraParams: raw && raw.config && raw.config.oauthConnectDefaults ? raw.config.oauthConnectDefaults.authorizeExtraParams || {} : {}
            },
            oauthCallbackPath: raw && raw.config ? raw.config.oauthCallbackPath || "" : ""
          },
          storage: raw && raw.storage ? raw.storage : initialPayload.storage,
          persisted: {
            upstreamIds: Array.isArray(raw && raw.persistedState && raw.persistedState.upstreams)
              ? raw.persistedState.upstreams.map((item) => item.id)
              : [],
            workspaceIds: Array.isArray(raw && raw.persistedState && raw.persistedState.workspaces)
              ? raw.persistedState.workspaces.map((item) => item.id)
              : [],
            upstreamCount: Array.isArray(raw && raw.persistedState && raw.persistedState.upstreams)
              ? raw.persistedState.upstreams.length
              : 0,
            workspaceCount: Array.isArray(raw && raw.persistedState && raw.persistedState.workspaces)
              ? raw.persistedState.workspaces.length
              : 0
          },
          workspaces: Array.isArray(raw && raw.workspaces) ? raw.workspaces : [],
          runtime: raw && raw.runtime ? raw.runtime : initialPayload.runtime
        };
      }

      function getRuntimeTeams(payload) {
        return Array.isArray(payload.runtime.scheduler) ? payload.runtime.scheduler.slice() : [];
      }

      function getVisibleTeams(payload) {
        const teams = getRuntimeTeams(payload);
        const selectedWorkspaceId = workspaceFilterNode.value;
        const workspaceMap = new Map(getWorkspaceOptions(payload).map((workspace) => [workspace.id, workspace]));
        const selectedWorkspace = workspaceMap.get(selectedWorkspaceId);
        const catalog = getUpstreamCatalogMap(payload);
        const memberships = getWorkspaceMembershipMap(payload);
        const searchQuery = String(teamSearchNode.value || "").trim().toLowerCase();
        const attentionFilter = teamAttentionFilterNode.value;

        const filtered = (selectedWorkspace
          ? teams.filter((team) => selectedWorkspace.upstreamIds.includes(team.id))
          : teams)
          .filter((team) => {
            const meta = catalog.get(team.id) || {};
            const health = latestHealthByUpstreamId[team.id];
            const statusView = getTeamStatusView(team, meta, health);

            if (!matchesAttentionFilter(attentionFilter, statusView)) {
              return false;
            }

            if (!searchQuery) {
              return true;
            }

            const haystack = [
              team.id,
              meta.baseUrl || "",
              (meta.models || []).join(" "),
              (memberships.get(team.id) || []).join(" "),
              team.lastError || "",
              team.lastOperation || ""
            ].join(" ").toLowerCase();
            return haystack.includes(searchQuery);
          });

        const sortMode = teamSortNode.value;
        filtered.sort((left, right) => {
          if (sortMode === "latency_desc") {
            return ((right.latency && right.latency.avgMs) || -1) - ((left.latency && left.latency.avgMs) || -1);
          }
          if (sortMode === "tokens_desc") {
            return ((right.usage && right.usage.totalTokens) || 0) - ((left.usage && left.usage.totalTokens) || 0);
          }
          if (sortMode === "errors_desc") {
            return (right.failedRequests || 0) - (left.failedRequests || 0);
          }
          if (sortMode === "name_asc") {
            return String(left.id).localeCompare(String(right.id));
          }
          return (right.totalRequests || 0) - (left.totalRequests || 0) || String(left.id).localeCompare(String(right.id));
        });

        return filtered;
      }

      function getUpstreamCatalogMap(payload) {
        return new Map((payload.config.upstreams || []).map((upstream) => [upstream.id, upstream]));
      }

      function getWorkspaceConfigMap(payload) {
        return new Map((payload.config.workspaces || []).map((workspace) => [workspace.id, workspace]));
      }

      function getWorkspaceMembershipMap(payload) {
        const membership = new Map();
        getWorkspaceOptions(payload).forEach((workspace) => {
          workspace.upstreamIds.forEach((upstreamId) => {
            const items = membership.get(upstreamId) ?? [];
            items.push(workspace.id + (workspace.isDefault ? " (default)" : ""));
            membership.set(upstreamId, items);
          });
        });
        return membership;
      }

      function renderSummary(payload) {
        const visibleTeams = getVisibleTeams(payload);
        const totalRequests = visibleTeams.reduce((sum, item) => sum + (item.totalRequests || 0), 0);
        const totalTokens = visibleTeams.reduce((sum, item) => sum + ((item.usage && item.usage.totalTokens) || 0), 0);
        const activeTeams = visibleTeams.filter((item) => !item.blockedUntil && item.lastStatus !== 0).length;
        const blockedTeams = visibleTeams.filter((item) => item.blockedUntil).length;
        const weightedLatency = visibleTeams.reduce((sum, item) => {
          return sum + (((item.latency && item.latency.avgMs) || 0) * ((item.latency && item.latency.samples) || 0));
        }, 0);
        const latencySamples = visibleTeams.reduce((sum, item) => sum + ((item.latency && item.latency.samples) || 0), 0);
        const averageLatency = latencySamples > 0 ? weightedLatency / latencySamples : undefined;
        const scope = workspaceFilterNode.value === "__all__" ? "All Workspaces" : workspaceFilterNode.value;

        const cards = [
          {
            label: "Visible Teams",
            value: String(visibleTeams.length),
            note: scope
          },
          {
            label: "Requests",
            value: String(totalRequests),
            note: activeTeams + " active, " + blockedTeams + " cooling down"
          },
          {
            label: "Average Latency",
            value: formatDurationMs(averageLatency, 1),
            note: "weighted by observed samples"
          },
          {
            label: "Token Usage",
            value: String(totalTokens),
            note: "prompt + completion"
          },
          {
            label: "Sticky Routes",
            value: String((payload.runtime.sessionRoutes && payload.runtime.sessionRoutes.active) || 0),
            note: "responses " + ((payload.runtime.responseRoutes && payload.runtime.responseRoutes.active) || 0)
          },
          {
            label: "Model Cache",
            value: String((payload.runtime.modelsCache && payload.runtime.modelsCache.length) || 0),
            note: "persisted sessions " + (payload.runtime.persistedSessionRoutes || 0)
          }
        ];

        summaryCardsNode.innerHTML = cards.map((card) => (
          '<article class="stat">' +
            '<div class="stat-label">' + escapeHtmlClient(card.label) + '</div>' +
            '<div class="stat-value">' + escapeHtmlClient(card.value) + '</div>' +
            '<div class="stat-note">' + escapeHtmlClient(card.note) + '</div>' +
          '</article>'
        )).join("");

        summaryMetaNode.textContent =
          "Updated " + new Date().toLocaleString("zh-CN", { hour12: false }) +
          " | Uptime " + formatDurationMs(payload.runtime.uptimeMs) +
          " | Started " + payload.runtime.startedAt;
      }

      function getTeamStatusView(team, meta, health) {
        if (meta.enabled === false) {
          return {
            rowClass: "team-row-muted",
            tone: "muted",
            text: "Disabled"
          };
        }

        if (team.blockedUntil) {
          return {
            rowClass: "team-row-warn",
            tone: "warn",
            text: "Cooling Down"
          };
        }

        if (health && health.ok === false) {
          return {
            rowClass: "team-row-danger",
            tone: "danger",
            text: "Health Check Failed"
          };
        }

        if (team.lastFailureAt && (!team.lastSuccessAt || team.lastFailureAt >= team.lastSuccessAt)) {
          return {
            rowClass: "team-row-danger",
            tone: "danger",
            text: "Recent Failures"
          };
        }

        return {
          rowClass: "",
          tone: "ok",
          text: "Serving"
        };
      }

      function matchesAttentionFilter(filterValue, statusView) {
        if (filterValue === "attention") {
          return statusView.tone !== "ok";
        }
        if (filterValue === "failed") {
          return statusView.text === "Recent Failures" || statusView.text === "Health Check Failed";
        }
        if (filterValue === "disabled") {
          return statusView.text === "Disabled";
        }
        if (filterValue === "cooling") {
          return statusView.text === "Cooling Down";
        }
        return true;
      }

      function renderTeams(payload) {
        const catalog = getUpstreamCatalogMap(payload);
        const memberships = getWorkspaceMembershipMap(payload);
        const persisted = new Set(payload.persisted.upstreamIds || []);
        const rows = getVisibleTeams(payload).map((team) => {
          const meta = catalog.get(team.id) || {};
          const health = latestHealthByUpstreamId[team.id];
          const isCodex = meta.kind === "openai" && meta.openaiMode === "codex";
          const healthBadge = health
            ? renderBadge(health.classification, health.ok ? "ok" : "warn")
            : "";
          const cooldownBadge = team.blockedUntil
            ? renderBadge("cooldown", "warn")
            : renderBadge("ready", "ok");
          const enabledBadge = meta.enabled === false
            ? renderBadge("disabled", "danger")
            : renderBadge("enabled", "ok");
          const statusView = getTeamStatusView(team, meta, health);

          return (
            '<tr class="' + statusView.rowClass + '">' +
              "<td>" +
                '<div class="cell-strong">' + escapeHtmlClient(team.id) + "</div>" +
                '<div class="cell-meta">' + escapeHtmlClient(meta.baseUrl || "") + "</div>" +
                '<div class="cell-meta">workspaces ' + escapeHtmlClient((memberships.get(team.id) || []).join(", ") || "(none)") + "</div>" +
                '<div class="cell-meta">models ' + escapeHtmlClient((meta.models || []).join(", ") || "(none)") + "</div>" +
                '<div class="cell-meta">source ' + escapeHtmlClient(persisted.has(team.id) ? "stored" : "env") + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="badge-row">' +
                  enabledBadge +
                  cooldownBadge +
                  renderBadge(meta.kind || "unknown") +
                  (isCodex ? renderBadge("codex", "ok") : "") +
                  healthBadge +
                "</div>" +
                '<div class="status-text ' + statusView.tone + '">' + escapeHtmlClient(statusView.text) + "</div>" +
                '<div class="cell-meta">last operation ' + escapeHtmlClient(team.lastOperation || "n/a") + "</div>" +
                '<div class="cell-meta">last request ' + escapeHtmlClient(formatTimestamp(team.lastRequestAt)) + "</div>" +
                (health ? '<div class="cell-meta">health ' + escapeHtmlClient(health.message) + "</div>" : "") +
              "</td>" +
              "<td>" +
                '<div class="cell-strong">total ' + escapeHtmlClient(String(team.totalRequests || 0)) + "</div>" +
                '<div class="cell-meta">ok ' + escapeHtmlClient(String(team.successfulRequests || 0)) + " / fail " + escapeHtmlClient(String(team.failedRequests || 0)) + " / net " + escapeHtmlClient(String(team.networkErrors || 0)) + "</div>" +
                '<div class="cell-meta">chat ' + escapeHtmlClient(String((team.requestCounts && team.requestCounts.chatCompletions) || 0)) + " / responses " + escapeHtmlClient(String((team.requestCounts && team.requestCounts.responses) || 0)) + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="cell-strong">avg ' + escapeHtmlClient(formatDurationMs(team.latency && team.latency.avgMs, 1)) + "</div>" +
                '<div class="cell-meta">last ' + escapeHtmlClient(formatDurationMs(team.latency && team.latency.lastMs)) + " / max " + escapeHtmlClient(formatDurationMs(team.latency && team.latency.maxMs)) + "</div>" +
                '<div class="cell-meta">samples ' + escapeHtmlClient(String((team.latency && team.latency.samples) || 0)) + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="cell-strong">total ' + escapeHtmlClient(String((team.usage && team.usage.totalTokens) || 0)) + "</div>" +
                '<div class="cell-meta">prompt ' + escapeHtmlClient(String((team.usage && team.usage.promptTokens) || 0)) + " / completion " + escapeHtmlClient(String((team.usage && team.usage.completionTokens) || 0)) + "</div>" +
                '<div class="cell-meta">usage updates ' + escapeHtmlClient(String((team.usage && team.usage.requestsWithUsage) || 0)) + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="action-row">' +
                  '<button type="button" class="secondary" data-action="view-team-detail" data-id="' + escapeHtmlClient(team.id) + '">Detail</button>' +
                  '<button type="button" class="secondary" data-action="check-upstream" data-id="' + escapeHtmlClient(team.id) + '">Health Check</button>' +
                  (persisted.has(team.id)
                    ? '<button type="button" class="secondary" data-action="edit-upstream" data-id="' + escapeHtmlClient(team.id) + '">Edit</button>'
                    : "") +
                  (!isCodex && meta.kind === "openai" && persisted.has(team.id)
                    ? '<button type="button" class="secondary" data-action="refresh-models" data-id="' + escapeHtmlClient(team.id) + '">Refresh Models</button>'
                    : "") +
                  (persisted.has(team.id)
                    ? (
                      '<button type="button" class="secondary" data-action="toggle-upstream" data-id="' + escapeHtmlClient(team.id) + '" data-enabled="' + String(meta.enabled === false) + '">' +
                        (meta.enabled === false ? "Enable" : "Disable") +
                      "</button>" +
                      '<button type="button" class="danger" data-action="delete-upstream" data-id="' + escapeHtmlClient(team.id) + '">Delete</button>'
                    )
                    : "") +
                "</div>" +
              "</td>" +
            "</tr>"
          );
        });

        teamsBodyNode.innerHTML = rows.length > 0
          ? rows.join("")
          : '<tr><td colspan="6" class="empty">No teams match the current workspace, search, or attention filters.</td></tr>';
      }

      function renderWorkspaces(payload) {
        const persisted = new Set(payload.persisted.workspaceIds || []);
        const rows = getWorkspaceOptions(payload).map((workspace) => {
          return (
            "<tr>" +
              "<td>" +
                '<div class="cell-strong">' + escapeHtmlClient(workspace.id) + "</div>" +
                '<div class="cell-meta">' + (workspace.isDefault ? "default workspace" : "non-default workspace") + "</div>" +
                '<div class="cell-meta">source ' + escapeHtmlClient(persisted.has(workspace.id) ? "stored" : "env") + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="badge-row">' +
                  (workspace.enabled ? renderBadge("enabled", "ok") : renderBadge("disabled", "danger")) +
                  (workspace.isDefault ? renderBadge("default", "ok") : "") +
                "</div>" +
                '<div class="cell-meta">upstreams ' + escapeHtmlClient(workspace.upstreamIds.join(", ") || "(none)") + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="cell-meta">' + escapeHtmlClient(workspace.availableModels.join(", ") || "(none)") + "</div>" +
              "</td>" +
              "<td>" +
                '<div class="action-row">' +
                  (persisted.has(workspace.id)
                    ? '<button type="button" class="secondary" data-action="edit-workspace" data-id="' + escapeHtmlClient(workspace.id) + '">Edit</button>'
                    : "") +
                  (persisted.has(workspace.id)
                    ? (
                      '<button type="button" class="secondary" data-action="toggle-workspace" data-id="' + escapeHtmlClient(workspace.id) + '" data-enabled="' + String(!workspace.enabled) + '">' +
                        (workspace.enabled ? "Disable" : "Enable") +
                      "</button>" +
                      '<button type="button" class="danger" data-action="delete-workspace" data-id="' + escapeHtmlClient(workspace.id) + '">Delete</button>'
                    )
                    : "") +
                "</div>" +
              "</td>" +
            "</tr>"
          );
        });

        workspacesBodyNode.innerHTML = rows.length > 0
          ? rows.join("")
          : '<tr><td colspan="4" class="empty">No workspaces configured.</td></tr>';
      }

      function renderAll(payload) {
        renderSummary(payload);
        renderTeams(payload);
        renderWorkspaces(payload);
      }

      function openModal(node) {
        node.classList.add("open");
      }

      function closeModal(node) {
        node.classList.remove("open");
      }

      function findUpstream(id) {
        return getUpstreamCatalogMap(pageState).get(id);
      }

      function findRuntimeTeam(id) {
        return getRuntimeTeams(pageState).find((team) => team.id === id);
      }

      function findWorkspace(id) {
        return getWorkspaceConfigMap(pageState).get(id);
      }

      function showTeamDetail(id) {
        const upstream = findUpstream(id);
        const team = findRuntimeTeam(id);
        if (!upstream || !team) {
          showFeedback("Cannot find team " + id, "error");
          return;
        }

        const health = latestHealthByUpstreamId[id];
        teamDetailTitleNode.textContent = id;
        teamDetailSubtitleNode.textContent = upstream.baseUrl;
        teamDetailBodyNode.innerHTML = [
          '<div class="mono-block">lastError: ' + escapeHtmlClient(team.lastError || "(none)") + '</div>',
          '<div class="mono-block">lastStatus: ' + escapeHtmlClient(String(team.lastStatus || "n/a")) + '\\nlastOperation: ' + escapeHtmlClient(team.lastOperation || "n/a") + '\\nlastRequestAt: ' + escapeHtmlClient(formatTimestamp(team.lastRequestAt)) + '\\nlastSuccessAt: ' + escapeHtmlClient(formatTimestamp(team.lastSuccessAt)) + '\\nlastFailureAt: ' + escapeHtmlClient(formatTimestamp(team.lastFailureAt)) + '</div>',
          '<div class="mono-block">requests: total=' + escapeHtmlClient(String(team.totalRequests || 0)) + ' ok=' + escapeHtmlClient(String(team.successfulRequests || 0)) + ' fail=' + escapeHtmlClient(String(team.failedRequests || 0)) + ' network=' + escapeHtmlClient(String(team.networkErrors || 0)) + '\\nlatency: avg=' + escapeHtmlClient(formatDurationMs(team.latency && team.latency.avgMs, 1)) + ' last=' + escapeHtmlClient(formatDurationMs(team.latency && team.latency.lastMs)) + ' max=' + escapeHtmlClient(formatDurationMs(team.latency && team.latency.maxMs)) + '\\nusage: prompt=' + escapeHtmlClient(String((team.usage && team.usage.promptTokens) || 0)) + ' completion=' + escapeHtmlClient(String((team.usage && team.usage.completionTokens) || 0)) + ' total=' + escapeHtmlClient(String((team.usage && team.usage.totalTokens) || 0)) + '</div>',
          health
            ? '<div class="mono-block">healthCheck: ' + escapeHtmlClient(JSON.stringify(health, null, 2)) + '</div>'
            : '<p class="helper">No health check result stored yet. Run Health Check from the table to populate this section.</p>'
        ].join("");
        openModal(teamDetailModalNode);
      }

      function openTeamEdit(id) {
        const upstream = findUpstream(id);
        if (!upstream) {
          showFeedback("Cannot find team " + id, "error");
          return;
        }

        teamEditFormNode.elements.id.value = upstream.id;
        teamEditFormNode.elements.baseUrl.value = upstream.baseUrl || "";
        teamEditFormNode.elements.authHeader.value = upstream.authHeader || "authorization_bearer";
        teamEditFormNode.elements.cooldownMs.value = upstream.cooldownMs || 30000;
        teamEditFormNode.elements.timeoutMs.value = upstream.timeoutMs || 120000;
        teamEditFormNode.elements.models.value = (upstream.models || []).join(",");
        teamEditFormNode.elements.headers.value = JSON.stringify(upstream.headers || {}, null, 2);
        teamEditFormNode.elements.enabled.checked = upstream.enabled !== false;
        teamEditFormNode.elements.apiKey.value = "";
        teamEditApiKeyFieldNode.style.display = upstream.authMode === "api_key" ? "grid" : "none";
        document.getElementById("team-edit-title").textContent = "Edit Team: " + upstream.id;
        openModal(teamEditModalNode);
      }

      function openWorkspaceEdit(id) {
        const workspace = findWorkspace(id);
        if (!workspace) {
          showFeedback("Cannot find workspace " + id, "error");
          return;
        }

        workspaceEditFormNode.elements.id.value = workspace.id;
        workspaceEditFormNode.elements.upstreamIds.value = (workspace.upstreamIds || []).join(",");
        workspaceEditFormNode.elements.modelMap.value = JSON.stringify(workspace.modelMap || {}, null, 2);
        workspaceEditFormNode.elements.enabled.checked = workspace.enabled !== false;
        workspaceEditFormNode.elements.isDefault.checked = workspace.isDefault === true;
        document.getElementById("workspace-edit-title").textContent = "Edit Workspace: " + workspace.id;
        openModal(workspaceEditModalNode);
      }

      function refreshWorkspaceFilterOptions(payload) {
        const prefs = loadUiPrefs();
        const currentValue = workspaceFilterNode.value || (typeof prefs.workspaceFilter === "string" ? prefs.workspaceFilter : "__all__");
        workspaceFilterNode.innerHTML = '<option value="__all__">All Workspaces</option>';
        getWorkspaceOptions(payload).forEach((workspace) => {
          const option = document.createElement("option");
          option.value = workspace.id;
          option.textContent = workspace.id + (workspace.isDefault ? " (default)" : "");
          workspaceFilterNode.appendChild(option);
        });
        const validValues = new Set(["__all__", ...getWorkspaceOptions(payload).map((workspace) => workspace.id)]);
        workspaceFilterNode.value = validValues.has(currentValue) ? currentValue : "__all__";
      }

      async function refreshPageState() {
        const payload = normalizePayload(await request("/admin/api/state"));
        pageState = payload;
        refreshWorkspaceFilterOptions(pageState);
        renderAll(pageState);
      }

      function setAutoRefresh() {
        if (refreshTimer) {
          clearInterval(refreshTimer);
        }
        if (autoRefreshNode.checked) {
          refreshTimer = setInterval(() => {
            refreshPageState().catch((error) => {
              showFeedback("Auto refresh failed: " + error.message, "warn");
            });
          }, 10000);
        }
      }

      function enableAttentionModeForCurrentWorkspace() {
        teamAttentionFilterNode.value = "attention";
        renderAll(pageState);
        saveUiPrefs();
        const scope = workspaceFilterNode.value === "__all__" ? "all workspaces" : workspaceFilterNode.value;
        showFeedback("Showing teams that need attention in " + scope + ".", "info");
      }

      async function startCodexTeamLogin(button) {
        const popup = window.open("", "gateway-codex-login", "popup=yes,width=960,height=760");
        try {
          const result = await runAction(
            button,
            "Preparing Codex Team login...",
            () => postJson("/admin/api/connectors/codex/start", {}),
            (payload) =>
              payload.forceLoginPrompt
                ? "Opened OpenAI login. Re-authenticate and choose the target Team."
                : "Opened OpenAI login. Complete the Team authorization in the popup."
          );

          if (popup) {
            popup.location.href = result.authorizationUrl;
            popup.focus();
            return;
          }

          showFeedback("Popup was blocked. Redirecting this tab to OpenAI login.", "warn");
          window.location.href = result.authorizationUrl;
        } catch (error) {
          if (popup) {
            popup.close();
          }
          throw error;
        }
      }

      function downloadFile(filename, content, type) {
        const blob = new Blob([content], { type });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
      }

      function exportVisibleTeamsAsJson() {
        downloadFile(
          "gateway-teams-" + Date.now() + ".json",
          JSON.stringify({
            exportedAt: new Date().toISOString(),
            workspace: workspaceFilterNode.value,
            sort: teamSortNode.value,
            teams: getVisibleTeams(pageState)
          }, null, 2),
          "application/json"
        );
      }

      function exportVisibleTeamsAsCsv() {
        const lines = [
          [
            "team",
            "workspace_scope",
            "total_requests",
            "successful_requests",
            "failed_requests",
            "network_errors",
            "avg_latency_ms",
            "last_latency_ms",
            "max_latency_ms",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "last_operation",
            "last_request_at",
            "last_success_at",
            "last_failure_at"
          ].join(",")
        ];

        getVisibleTeams(pageState).forEach((team) => {
          const values = [
            team.id,
            workspaceFilterNode.value,
            team.totalRequests || 0,
            team.successfulRequests || 0,
            team.failedRequests || 0,
            team.networkErrors || 0,
            formatNumber(team.latency && team.latency.avgMs, 1),
            formatNumber(team.latency && team.latency.lastMs, 0),
            formatNumber(team.latency && team.latency.maxMs, 0),
            (team.usage && team.usage.promptTokens) || 0,
            (team.usage && team.usage.completionTokens) || 0,
            (team.usage && team.usage.totalTokens) || 0,
            team.lastOperation || "",
            formatTimestamp(team.lastRequestAt),
            formatTimestamp(team.lastSuccessAt),
            formatTimestamp(team.lastFailureAt)
          ].map((value) => '"' + String(value).replaceAll('"', '""') + '"');
          lines.push(values.join(","));
        });

        downloadFile("gateway-teams-" + Date.now() + ".csv", lines.join("\\n"), "text/csv;charset=utf-8");
      }

      async function runAction(button, startMessage, action, successMessage) {
        const originalText = button ? button.textContent : "";
        if (button) {
          button.disabled = true;
          button.textContent = "Working...";
        }
        showFeedback(startMessage, "info");
        try {
          const result = await action();
          if (successMessage) {
            showFeedback(typeof successMessage === "function" ? successMessage(result) : successMessage, "success");
          }
          return result;
        } catch (error) {
          showFeedback(error.message, "error");
          throw error;
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = originalText;
          }
        }
      }

      async function handleTeamAction(button) {
        const action = button.dataset.action;
        const id = button.dataset.id;
        if (!action || !id) {
          return;
        }

        if (action === "check-upstream") {
          const result = await runAction(
            button,
            "Checking " + id + "...",
            () => postJson("/admin/api/upstreams/" + encodeURIComponent(id) + "/check", {}),
            (payload) => "Health check: " + payload.classification + " - " + payload.message
          );
          latestHealthByUpstreamId[id] = result;
          renderAll(pageState);
          return;
        }

        if (action === "view-team-detail") {
          showTeamDetail(id);
          return;
        }

        if (action === "edit-upstream") {
          openTeamEdit(id);
          return;
        }

        if (action === "refresh-models") {
          await runAction(
            button,
            "Refreshing models for " + id + "...",
            () => postJson("/admin/api/upstreams/" + encodeURIComponent(id) + "/refresh-models", {}),
            (payload) => "Refreshed " + payload.models.length + " models for " + id
          );
          await refreshPageState();
          return;
        }

        if (action === "toggle-upstream") {
          const enabled = button.dataset.enabled === "true";
          await runAction(
            button,
            (enabled ? "Enabling " : "Disabling ") + id + "...",
            () => postJson("/admin/api/upstreams/" + encodeURIComponent(id) + "/enabled", { enabled }),
            "Updated upstream " + id
          );
          await refreshPageState();
          return;
        }

        if (action === "delete-upstream") {
          if (!confirm("Delete upstream " + id + "?")) {
            return;
          }
          await runAction(
            button,
            "Deleting " + id + "...",
            () => deleteRequest("/admin/api/upstreams/" + encodeURIComponent(id)),
            "Deleted upstream " + id
          );
          delete latestHealthByUpstreamId[id];
          await refreshPageState();
        }
      }

      async function handleWorkspaceAction(button) {
        const action = button.dataset.action;
        const id = button.dataset.id;
        if (!action || !id) {
          return;
        }

        if (action === "toggle-workspace") {
          const enabled = button.dataset.enabled === "true";
          await runAction(
            button,
            (enabled ? "Enabling " : "Disabling ") + id + "...",
            () => postJson("/admin/api/workspaces/" + encodeURIComponent(id) + "/enabled", { enabled }),
            "Updated workspace " + id
          );
          await refreshPageState();
          return;
        }

        if (action === "edit-workspace") {
          openWorkspaceEdit(id);
          return;
        }

        if (action === "delete-workspace") {
          if (!confirm("Delete workspace " + id + "?")) {
            return;
          }
          await runAction(
            button,
            "Deleting " + id + "...",
            () => deleteRequest("/admin/api/workspaces/" + encodeURIComponent(id)),
            "Deleted workspace " + id
          );
          await refreshPageState();
        }
      }

      document.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const button = target.closest("button[data-action]");
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }

        try {
          if (["check-upstream", "refresh-models", "toggle-upstream", "delete-upstream", "view-team-detail", "edit-upstream"].includes(button.dataset.action || "")) {
            await handleTeamAction(button);
            return;
          }

          if (["toggle-workspace", "delete-workspace", "edit-workspace"].includes(button.dataset.action || "")) {
            await handleWorkspaceAction(button);
          }
        } catch {
          /* feedback already shown */
        }
      });

      document.getElementById("close-team-detail").addEventListener("click", () => closeModal(teamDetailModalNode));
      document.getElementById("close-team-edit").addEventListener("click", () => closeModal(teamEditModalNode));
      document.getElementById("close-workspace-edit").addEventListener("click", () => closeModal(workspaceEditModalNode));

      [teamDetailModalNode, teamEditModalNode, workspaceEditModalNode].forEach((node) => {
        node.addEventListener("click", (event) => {
          if (event.target === node) {
            closeModal(node);
          }
        });
      });

      document.getElementById("refresh-page").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        await runAction(button, "Refreshing admin state...", () => refreshPageState(), "Admin state refreshed.");
      });

      connectCodexTeamButtonNode.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        try {
          await startCodexTeamLogin(button);
        } catch {
          /* feedback already shown */
        }
      });

      document.getElementById("export-json").addEventListener("click", () => {
        exportVisibleTeamsAsJson();
        showFeedback("Exported visible teams as JSON.", "success");
      });

      document.getElementById("export-csv").addEventListener("click", () => {
        exportVisibleTeamsAsCsv();
        showFeedback("Exported visible teams as CSV.", "success");
      });

      workspaceFilterNode.addEventListener("change", () => {
        renderAll(pageState);
        saveUiPrefs();
        showFeedback("Workspace filter set to " + workspaceFilterNode.value + ".", "info");
      });

      teamSearchNode.addEventListener("input", () => {
        renderAll(pageState);
        saveUiPrefs();
      });

      teamSortNode.addEventListener("change", () => {
        renderAll(pageState);
        saveUiPrefs();
        showFeedback("Sort set to " + teamSortNode.value + ".", "info");
      });

      teamAttentionFilterNode.addEventListener("change", () => {
        renderAll(pageState);
        saveUiPrefs();
        const value = teamAttentionFilterNode.value;
        const label =
          value === "attention"
            ? "teams that need attention"
            : value === "failed"
              ? "failed teams"
              : value === "disabled"
                ? "disabled teams"
                : value === "cooling"
                  ? "teams cooling down"
                  : "all teams";
        showFeedback("Showing " + label + ".", "info");
      });

      teamAttentionWorkspaceButtonNode.addEventListener("click", () => {
        enableAttentionModeForCurrentWorkspace();
      });

      autoRefreshNode.addEventListener("change", () => {
        setAutoRefresh();
        saveUiPrefs();
        showFeedback(autoRefreshNode.checked ? "Auto refresh enabled." : "Auto refresh paused.", "info");
      });

      document.getElementById("openai-api-key-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Saving OpenAI upstream...",
          () => postJson("/admin/api/upstreams", {
            id: form.get("id"),
            kind: "openai",
            baseUrl: form.get("baseUrl"),
            apiKey: form.get("apiKey"),
            authMode: "api_key",
            authHeader: "authorization_bearer",
            enabled: form.get("enabled") === "on",
            models: splitCsv(form.get("models")),
            headers: parseJsonOrDefault(String(form.get("headers") || ""), {})
          }),
          "Saved OpenAI upstream."
        );
        formElement.reset();
        formElement.querySelector('input[name="enabled"]').checked = true;
        await refreshPageState();
      });

      document.getElementById("anthropic-api-key-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Saving Anthropic upstream...",
          () => postJson("/admin/api/upstreams", {
            id: form.get("id"),
            kind: "anthropic",
            baseUrl: form.get("baseUrl"),
            apiKey: form.get("apiKey"),
            authMode: "api_key",
            authHeader: "x-api-key",
            enabled: form.get("enabled") === "on",
            models: splitCsv(form.get("models")),
            headers: parseJsonOrDefault(String(form.get("headers") || ""), {})
          }),
          "Saved Anthropic upstream."
        );
        formElement.reset();
        formElement.querySelector('input[name="enabled"]').checked = true;
        await refreshPageState();
      });

      document.getElementById("workspace-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Saving workspace...",
          () => postJson("/admin/api/workspaces", {
            id: form.get("id"),
            upstreamIds: splitCsv(form.get("upstreamIds")),
            modelMap: parseJsonOrDefault(String(form.get("modelMap") || ""), {}),
            enabled: form.get("enabled") === "on",
            isDefault: form.get("isDefault") === "on"
          }),
          "Saved workspace."
        );
        formElement.reset();
        formElement.querySelector('input[name="enabled"]').checked = true;
        await refreshPageState();
      });

      teamEditFormNode.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const patch = {
          baseUrl: form.get("baseUrl"),
          authHeader: form.get("authHeader"),
          cooldownMs: Number(form.get("cooldownMs") || 0),
          timeoutMs: Number(form.get("timeoutMs") || 0),
          models: splitCsv(form.get("models")),
          headers: parseJsonOrDefault(String(form.get("headers") || ""), {}),
          enabled: form.get("enabled") === "on"
        };
        const apiKey = String(form.get("apiKey") || "").trim();
        if (apiKey) {
          patch.apiKey = apiKey;
        }

        await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Saving team changes...",
          () => postJson("/admin/api/upstreams/" + encodeURIComponent(String(form.get("id"))) + "/edit", patch),
          "Team updated."
        );
        closeModal(teamEditModalNode);
        await refreshPageState();
      });

      workspaceEditFormNode.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Saving workspace changes...",
          () => postJson("/admin/api/workspaces/" + encodeURIComponent(String(form.get("id"))) + "/edit", {
            upstreamIds: splitCsv(form.get("upstreamIds")),
            modelMap: parseJsonOrDefault(String(form.get("modelMap") || ""), {}),
            enabled: form.get("enabled") === "on",
            isDefault: form.get("isDefault") === "on"
          }),
          "Workspace updated."
        );
        closeModal(workspaceEditModalNode);
        await refreshPageState();
      });

      async function startOAuth(event, kind) {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const authorizeExtraParams = parseAuthorizeExtraParams(form);
        const oauth2Payload = {
          authorizationUrl: form.get("authorizationUrl"),
          tokenUrl: form.get("tokenUrl"),
          clientId: form.get("clientId"),
          clientSecret: form.get("clientSecret"),
          scopes: splitScopes(form.get("scopes")),
          accessToken: "__pending__"
        };
        if (authorizeExtraParams) {
          oauth2Payload.authorizeExtraParams = authorizeExtraParams;
        }

        const result = await runAction(
          formElement.querySelector('button[type="submit"]'),
          "Starting OAuth flow...",
          () => postJson("/admin/api/connectors/oauth/start", {
            id: form.get("id"),
            kind,
            baseUrl: form.get("baseUrl"),
            authMode: "oauth2",
            authHeader: form.get("authHeader"),
            enabled: form.get("enabled") === "on",
            models: splitCsv(form.get("models")),
            headers: parseJsonOrDefault(String(form.get("headers") || ""), {}),
            oauth2: oauth2Payload
          }),
          "Redirecting to OAuth provider..."
        );

        window.location.href = result.authorizationUrl;
      }

      document.getElementById("oauth-openai-form").addEventListener("submit", (event) => {
        void startOAuth(event, "openai");
      });

      document.getElementById("oauth-anthropic-form").addEventListener("submit", (event) => {
        void startOAuth(event, "anthropic");
      });

      window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) {
          return;
        }

        const data = event.data;
        if (!data || data.type !== "gateway:oauth-complete") {
          return;
        }

        showFeedback(
          typeof data.message === "string" ? data.message : (data.ok ? "Team connected." : "Team login failed."),
          data.ok ? "success" : "error"
        );
        void refreshPageState().catch((error) => {
          showFeedback("Connected, but refresh failed: " + error.message, "warn");
        });
      });

      try {
        pageState = normalizePayload(pageState);
        applyUiPrefs();
        refreshWorkspaceFilterOptions(pageState);
        renderAll(pageState);
        setAutoRefresh();
        saveUiPrefs();
        showFeedback("Admin page ready.", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showFeedback("Admin page failed to initialize: " + message, "error");
        teamsBodyNode.innerHTML = '<tr><td colspan="6" class="empty">Failed to initialize admin page. ' + escapeHtmlClient(message) + '</td></tr>';
        workspacesBodyNode.innerHTML = '<tr><td colspan="4" class="empty">Failed to initialize admin page. ' + escapeHtmlClient(message) + '</td></tr>';
      }
    </script>
  </body>
</html>`;
}
