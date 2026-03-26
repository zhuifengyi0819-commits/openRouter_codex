# Compatible LLM Gateway

这是一个本地多工作区代理，当前更适合的定位是：

- 聚合多个 Codex / ChatGPT OAuth 登录态
- 通过统一网关暴露 OpenAI 风格接口
- 同时兼容普通 OpenAI-compatible API Key upstream
- 可选支持 Anthropic-compatible upstream

当前推荐主链路是 `Codex subscription proxy`，也就是通过 `npm run login` 引入 ChatGPT / Codex 账号，再由网关把请求转发到 `https://chatgpt.com/backend-api/codex/responses`。

## 1. 功能概览

- OpenAI 风格接口：`/v1/chat/completions`、`/v1/responses`、`/v1/models`
- Anthropic 风格接口：`/v1/messages`
- 多 `workspace` 路由
- 多 team 单请求 failover（429 / 5xx / 网络错误）
- `session_id` / `prompt_cache_key` 会话级 team 粘性路由，提升上游缓存命中率
- `chat.completions` 支持图片 / 音频 / 文件输入透传到 Codex Responses
- `chat.completions` 支持 `tools`、`tool_choice`、`parallel_tool_calls`、`tool_calls` 历史回放
- 浏览器管理页
- 管理页可查看 team 级请求量、失败量、延时和 token 使用量
- 本地加密存储 upstream 凭据
- `responseId -> upstream` 粘性路由持久化，重启后保留
- Codex upstream 健康检查、启停、删除
- 普通 OpenAI-compatible upstream 模型刷新
- 运行态摘要接口：`/health`、`/ready`、`/admin/api/runtime`

## 2. 环境要求

- Node.js `>= 20.11.0`
- npm `>= 10`

安装依赖：

```bash
npm install
```

## 3. 快速开始

### 3.1 准备配置

```bash
cp .env.example .env
```

最小必填项通常是：

```env
PORT=3000
HOST=0.0.0.0
GATEWAY_API_KEYS=dev-gateway-key
DATA_DIR=.gateway-data
MODEL_MAP_JSON={}
UPSTREAMS_JSON=[]
WORKSPACES_JSON=[]
```

如果你准备聚合 Codex 账号，确认这些默认值是对的：

```env
OAUTH_CALLBACK_PORT=1455
OAUTH_CALLBACK_PATH=/auth/callback
OAUTH_REDIRECT_ORIGIN=
OAUTH_CONNECT_PROVIDER_ORIGIN=https://auth.openai.com
OAUTH_CONNECT_AUTHORIZE_PATH=/oauth/authorize
OAUTH_CONNECT_TOKEN_PATH=/oauth/token
OAUTH_CONNECT_API_BASE_URL=https://chatgpt.com/backend-api
```

说明：

- Web 管理页里的 `Connect Codex Team` 会先回到本地 `http://localhost:1455/auth/callback`
- 这个本地 relay 再把浏览器转回当前网关的 `${OAUTH_CALLBACK_PATH}` 页面完成保存
- `OAUTH_REDIRECT_ORIGIN` 本地默认留空，只影响通用 OAuth 连接器；放在反向代理或公网域名后面时再手动指定

### 3.2 通过 CLI 登录 Codex

第一次建议直接运行：

```bash
npm run login
```

它会：

- 启动本地管理服务
- 打开浏览器进入管理页
- 由管理页里的 `Connect Codex Team` 发起 Codex / ChatGPT OAuth 登录
- 把 token 和 `accountId` 存入本地加密状态
- 自动保存或覆盖对应的 `openaiMode=codex` upstream

说明：

- ChatGPT / Codex 账号不要走管理页里的 `OAuth OpenAI-Compatible` 表单
- 那个表单只给“官方支持 OAuth2 且暴露标准 OpenAI-compatible API”的 provider 用

### 3.3 启动服务

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm run build
npm run start
```

回归测试：

```bash
npm test
```

## 4. 配置说明

### 4.1 `.gateway-data`

默认会生成：

- `.gateway-data/master.key`
- `.gateway-data/state.enc.json`

其中保存：

- OAuth access / refresh token
- API Key upstream
- workspace 配置

不要提交 `.env` 和 `.gateway-data`。

### 4.2 `UPSTREAMS_JSON`

你可以直接在 `.env` 里声明静态 upstream，也可以完全留空，改为通过管理页或 `npm run login` 添加。

普通 OpenAI-compatible upstream 示例：

```json
[
  {
    "id": "openai-primary",
    "kind": "openai",
    "baseUrl": "https://api.openai.com",
    "apiKey": "sk-...",
    "models": ["gpt-4.1", "gpt-4.1-mini"]
  }
]
```

静态 Codex upstream 示例：

```json
[
  {
    "id": "codex-team-a",
    "kind": "openai",
    "openaiMode": "codex",
    "baseUrl": "https://chatgpt.com/backend-api",
    "authMode": "oauth2",
    "models": ["gpt-5.4", "gpt-5.4-mini"],
    "oauth2": {
      "authorizationUrl": "https://auth.openai.com/oauth/authorize",
      "tokenUrl": "https://auth.openai.com/oauth/token",
      "clientId": "...",
      "clientSecret": "...",
      "accessToken": "...",
      "refreshToken": "...",
      "accountId": "..."
    }
  }
]
```

注意：

- Codex upstream 不支持从 `/v1/models` 自动刷新
- 模型列表需要在网关里手工维护
- 网关会按 `responseId` 记住上游，避免 `GET/DELETE /v1/responses/:id` 打错账号
- 这份映射会加密持久化到 `.gateway-data/state.enc.json`
- `chat.completions` 会在网关内转换成 Codex `/codex/responses` 请求

### 4.3 `WORKSPACES_JSON`

示例：

```json
[
  {
    "id": "team-a",
    "upstreamIds": ["codex-team-a"],
    "modelMap": {"gpt-5":"gpt-5.4"},
    "isDefault": true
  }
]
```

`workspace` 负责：

- 绑定允许使用的 upstream
- 提供稳定的路由入口
- 做模型别名映射

## 5. 管理页

通过 `npm run login` 或服务启动时打印出的链接进入 `/admin/setup`。

你可以在页面里：

- 查看 upstream / workspace 状态
- 新增普通 API Key upstream
- 新增非 Codex 的 OAuth-compatible upstream
- 做健康检查
- 启停或删除持久化项

当前规则：

- `Codex subscription` upstream 会显示专用标记
- 这类 upstream 不显示 `Refresh Models`
- 管理页状态接口已经做了 token 脱敏
- `/admin/api/runtime` 和管理页可查看 team 级 cooldown、请求成功/失败计数、延时、token 用量、缓存和粘性路由摘要

## 6. 调用示例

查看模型：

```bash
curl http://localhost:3000/v1/models \
  -H 'Authorization: Bearer dev-gateway-key'
```

调用 Chat Completions：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer dev-gateway-key' \
  -H 'Content-Type: application/json' \
  -H 'x-workspace-id: team-a' \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "hello"}
    ],
    "stream": true
  }'
```

如果你希望多 team 下稳定命中同一个上游 cache，显式带一个固定 `session_id`：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer dev-gateway-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.4",
    "session_id": "project-alpha-thread-01",
    "messages": [
      {"role": "user", "content": "continue"}
    ]
  }'
```

带工具和多模态输入的示例：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer dev-gateway-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.4",
    "tools": [{
      "type": "function",
      "function": {
        "name": "lookup_weather",
        "description": "Lookup current weather",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }],
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "这是什么图，同时查一下上海天气" },
        { "type": "image_url", "image_url": { "url": "https://example.com/cat.png" } }
      ]
    }]
  }'
```

## 7. 生产建议

- 多 team 场景优先走 `/v1/responses`，它和 Codex backend 语义最接近
- 多 team 想稳定命中上游 prompt cache，给相同会话固定传 `session_id`
- 如果客户端后续要 `GET/DELETE /v1/responses/:id`，保留响应头里的 `x-gateway-upstream`
- 用 `/ready` 做实例 readiness，用 `/health` 看完整运行态摘要
- 上线前至少跑一次 `npm test && npm run build`
- 复杂多模态或需要完整原生字段时，仍优先用 `/v1/responses`，兼容层主要解决 `chat.completions` 接入成本

调用 Responses：

```bash
curl http://localhost:3000/v1/responses \
  -H 'Authorization: Bearer dev-gateway-key' \
  -H 'Content-Type: application/json' \
  -H 'x-workspace-id: team-a' \
  -d '{
    "model": "gpt-5.4",
    "input": "hello"
  }'
```

Anthropic 请求：

```bash
curl http://localhost:3000/v1/messages \
  -H 'Authorization: Bearer dev-gateway-key' \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-3-7-sonnet-latest",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## 7. 已知边界

- Codex 代理当前优先保证 `/v1/responses` 和 `chat.completions` 可用
- `embeddings` 只会路由到普通 OpenAI-compatible upstream，不会打到 Codex upstream
- `GET /v1/models/:id` 在纯 Codex workspace 下依赖网关本地模型清单
- 真实联机行为仍取决于上游账号配额、订阅状态和 OpenAI 后端协议变化

## 8. 常用命令

```bash
npm install
npm run login
npm run dev
npm run check
npm run build
npm run start
```
