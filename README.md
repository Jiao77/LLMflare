# LLMflare

部署在 Cloudflare Workers 上的免费 LLM API 聚合网关。把 Gemini、Groq、OpenRouter、NVIDIA、Workers AI 等供应商集中到一个 Base URL，通过统一的 OpenAI / Anthropic 兼容接口调用。

Free LLM API aggregator powered by Cloudflare Workers. Run multiple providers behind one OpenAI and Anthropic compatible endpoint without hosting a local service or VPS.

`免费 AI 聚合` · `Cloudflare Workers` · `不占本机资源` · `国内网络访问` · `自定义域名` · `OpenAI / Anthropic Compatible`

## LLMflare 解决什么问题

- **聚合免费 AI 供应商**：集中管理不同平台提供的免费模型、免费额度和 API Key，部分 Provider 支持自动筛选免费模型。
- **不占用本机资源**：网关运行在 Cloudflare Workers，无需在电脑、NAS 或 VPS 上常驻进程，也不消耗本机算力和带宽处理上游请求。
- **更方便地访问国外 API**：客户端只连接自己的 Worker 或自定义域名，上游请求由 Cloudflare 网络发起；在许多国内网络环境中可以直接使用原本难以连接的国外 API，无需在客户端配置代理。
- **支持自定义域名**：可以绑定自己的域名作为统一 API 地址，也可以直接使用 Cloudflare 提供的 `*.workers.dev` 地址。
- **一个 Base URL 接入多个厂商**：统一管理 Provider、API Key 和开放模型，切换供应商时无需反复修改客户端地址。
- **兼容常用协议**：支持 OpenAI Chat Completions、Responses 与 Anthropic Messages。
- **原样流式转发**：上游流式响应直接传给客户端，并在旁路记录首字延迟、TPS 和 Token。
- **模型白名单**：只向客户端暴露已勾选的模型，部分 Provider 支持只看免费模型。
- **隐私优先**：不保存 Prompt 和模型回复；统计只记录模型、Token、耗时和状态等元数据。

> [!WARNING]
> LLMflare 也可以接入按量计费或充值余额的 API 服务，但更建议只添加免费 API 或单独申请的低额度 Key。Provider Key 需要保存在部署者自己的 Cloudflare KV 中；若管理凭据、客户端密钥或部署环境泄露，攻击者可能消耗付费额度并造成财产损失。请勿使用绑定高额余额或无限制付款方式的生产 Key。

![LLMflare 管理台总览](docs/images/dashboard.png)

![Provider 免费模型筛选与白名单](docs/images/model-selection.png)

> 截图使用演示数据，不包含真实 API Key、域名配置或个人用量。

## 请求架构

LLMflare 把客户端鉴权、模型路由、协议适配和用量统计放在同一个 Worker 中。客户端只持有 `llmf_` 访问密钥；Provider Key 留在部署者自己的 Cloudflare KV，Prompt 与回复正文不会写入 D1。

```mermaid
flowchart LR
    Client[OpenAI SDK / Codex / Claude Code] -->|HTTPS + llmf_ key| Worker[LLMflare Worker]
    Worker --> Auth[客户端密钥鉴权]
    Auth --> Route[按 Provider/模型白名单路由]
    Route --> Adapt{接口与上游能力匹配?}
    Adapt -->|匹配| Pass[原生流式转发]
    Adapt -->|不匹配| Convert[请求与 SSE 事件转换]
    Pass --> Providers[Gemini / Groq / OpenRouter / NVIDIA / Workers AI / ...]
    Convert --> Providers
    Providers -->|JSON 或 SSE| Worker
    Worker -. 元数据 .-> D1[(D1 用量统计)]
    Worker -->|JSON 或逐事件 SSE| Client
    KV[(KV: Provider 配置与 Key)] -.-> Route
```

请求不会先缓冲完整回复再返回。流式转换器读取一个上游 SSE 事件就生成对应的客户端事件，同时旁路计算首字延迟、耗时、Token 和 TPS。

## 3 分钟快速开始

需要 Node.js 20+、Cloudflare 账号，以及至少一个 AI Provider 的 API Key。建议先使用带免费额度的 Provider 完成部署和测试。

```bash
git clone https://github.com/Jiao77/LLMflare.git
cd LLMflare
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create CONFIG
npx wrangler d1 create llmflare-usage
```

Windows PowerShell 请将复制命令改为：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

把命令输出的 KV、D1 ID 填入 `wrangler.jsonc`，然后执行：

```bash
npx wrangler d1 migrations apply USAGE --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

打开 Worker 地址，用 `ADMIN_TOKEN` 登录后台并添加 Provider。完整部署、安全配置和自定义域名说明见下方。

## 兼容接口

| 接口 | 协议 | 流式传输 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | 支持 |
| `POST /v1/responses` | OpenAI Responses | 支持 |
| `POST /v1/messages` | Anthropic Messages | 支持 |
| `GET /v1/models` | OpenAI Models | — |

客户端使用后台生成的访问密钥：

```http
Authorization: Bearer llmf_your_client_key
```

模型名使用 `供应商名称/上游模型 ID`，例如：

```json
{
  "model": "Groq/openai/gpt-oss-20b",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

Chat Completions 默认直接转发；Responses 在上游原生接口可用时直接透传，其他 Responses 与 Messages 请求走协议适配。转换流不会等待完整回复，而是按事件逐个转换并立即发送给客户端。

```mermaid
flowchart LR
    Client[客户端] --> Gateway[LLMflare<br/>鉴权 · 模型路由]
    Gateway --> Chat[Chat Completions]
    Gateway --> Responses[Responses]
    Gateway --> Messages[Messages]
    Chat -->|直接转发| Provider[上游 Provider]
    Responses -->|原生接口可用| Provider
    Responses -->|否则| Adapter[逐事件流式转换]
    Messages --> Adapter
    Adapter -->|Chat Completions| Provider
    Provider -->|JSON / SSE| Client
```

Responses 适配包括 `instructions`、`input`、reasoning effort 和函数工具；Messages 适配包括 system prompt、文本/图片内容块、`tool_use`、`tool_result`、`tool_choice` 与 Anthropic SSE 事件。

> [!NOTE]
> 协议适配优先保证文本、多模态消息和函数工具调用。Responses 的 Web Search、File Search、Computer Use 等非 `function` 内建工具不会转发给只支持 Chat Completions 的上游；最终能力也受所选模型和 Provider 限制。

## Codex / Claude Code 专项适配

### Codex

Codex 当前使用 Responses 协议接入自定义 Provider。LLMflare 针对 Codex 请求做了以下兼容处理：

- 接收 `instructions`、Responses `input`、`reasoning.effort` 与函数工具定义。
- 在 Chat-only 上游中转换 system/user/tool 消息，并把 `reasoning.effort` 映射为 `reasoning_effort`。
- 过滤上游不支持的 Responses 专属字段，避免兼容接口直接返回参数错误。
- 将文本增量、函数名和分段 JSON 参数转换为带连续 `sequence_number` 的 Responses SSE 事件。
- 客户端中断连接时同步取消上游读取，减少无效请求与免费额度浪费。

```mermaid
flowchart LR
    Codex[Codex<br/>Responses + function tools] --> Gateway[LLMflare /v1/responses]
    Gateway --> Normalize[输入规范化<br/>instructions / input / reasoning]
    Normalize --> ToolMap[function_call 与 tool output 映射]
    ToolMap --> Upstream[免费或自建 Chat 模型]
    Upstream --> StreamMap[文本与工具参数<br/>逐事件转 Responses SSE]
    StreamMap --> Codex
```

在 `~/.codex/config.toml` 中增加自定义 Provider。`model` 必须填写管理后台 `/v1/models` 返回的完整名称：

```toml
model = "NVIDIA/openai/gpt-oss-120b"
model_provider = "llmflare"

[model_providers.llmflare]
name = "LLMflare"
base_url = "https://llm.example.com/v1"
env_key = "LLMFLARE_API_KEY"
wire_api = "responses"
```

再从启动 Codex 的同一个终端注入客户端密钥：

```bash
export LLMFLARE_API_KEY="llmf_your_client_key"
codex
```

Provider 配置字段可参考 [Codex Configuration Reference](https://developers.openai.com/codex/config-reference/)。不要把客户端密钥直接写入 `config.toml` 或提交到仓库。

### Claude Code

Claude Code 使用 Anthropic Messages 协议。LLMflare 为这类长会话补齐了工具调用双向转换、Anthropic SSE 事件、错误类型映射，并为 NVIDIA Messages 请求设置 60 秒首字节截止时间，避免上游 524/长时间无响应让 Agent 一直挂起。

```mermaid
flowchart LR
    Claude[Claude Code<br/>Messages + tool_use] --> Gateway[LLMflare /v1/messages]
    Gateway --> RequestMap[system / content blocks<br/>tool_use / tool_result 转换]
    RequestMap --> Upstream[OpenAI-compatible Provider]
    Upstream --> ResponseMap[tool_calls / finish_reason<br/>错误与 SSE 事件转换]
    ResponseMap --> Claude
```

先在当前终端测试。`ANTHROPIC_BASE_URL` 填域名根地址，不要附加 `/v1`：

```bash
export ANTHROPIC_BASE_URL="https://llm.example.com"
export ANTHROPIC_AUTH_TOKEN="llmf_your_client_key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

启动后可用 `/model` 选择 LLMflare 暴露的 `Provider/模型`，再用 `/status` 确认 Base URL 与 `ANTHROPIC_AUTH_TOKEN` 已生效。若要持久化，可将这些变量放进 `~/.claude/settings.json` 的 `env`，但不要写入会提交的项目级设置。详见 [Claude Code: Connect to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)。

## 支持的 Provider

| Provider | 自动获取模型 | 免费模型筛选 | 备注 |
| --- | ---: | ---: | --- |
| Google AI Studio | ✓ | — | Gemini API |
| Groq | ✓ | — | OpenAI-compatible |
| OpenRouter | ✓ | ✓ | 按价格信息识别免费模型 |
| NVIDIA NIM | ✓ | ✓ | OpenAI-compatible |
| Cloudflare Workers AI | ✓ | — | 支持 REST API Token + Account ID，也支持原生 AI Binding |
| SiliconFlow | ✓ | ✓ | OpenAI-compatible |
| 智谱 BigModel | ✓ | ✓ | OpenAI-compatible |
| Mistral | ✓ | — | 可见模型可能消耗套餐额度或按量计费，不自动判断免费 |
| 自定义 OpenAI-compatible | 视上游而定 | — | 可配置 Base URL |

免费模型筛选依赖各平台模型目录返回的价格、标签或命名信息；平台规则变化时，识别结果也可能变化。是否免费及额度大小始终以上游官方说明为准。项目允许添加收费 API，但出于密钥泄露和意外扣费风险，更建议仅接入免费服务或设置了严格额度限制的专用 Key。

Mistral 的模型目录只表示当前账户可访问的模型，不提供足以证明零价格的信息，因此 LLMflare 不会把整个目录标记为免费。免费套餐中的月度额度与“模型本身免费”是两件事；是否继续按量计费取决于账户的 Pay-as-you-go 设置。

## 管理后台

- 新增、编辑和删除 Provider
- 修改显示名称、API Key、Base URL 与 Account ID
- 自动获取模型并按分组筛选
- 勾选允许通过网关访问的模型
- 生成、自定义、停用和删除客户端访问密钥
- 为每个客户端密钥设置 RPM、过去 24 小时请求、本月 Token 与单次最大输出 Token 限制
- 在线测试兼容接口
- 按 Provider 和模型查看 Token、请求数、成功率、首字延迟与 TPS

## 完整部署配置

### 1. 创建资源

```bash
npx wrangler kv namespace create CONFIG
npx wrangler d1 create llmflare-usage
```

### 2. 配置 `wrangler.jsonc`

从 `wrangler.example.jsonc` 复制一份配置，将资源 ID 替换为自己的值：

```jsonc
{
  "name": "llmflare",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-25",
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "YOUR_KV_NAMESPACE_ID" }
  ],
  "d1_databases": [
    {
      "binding": "USAGE",
      "database_name": "llmflare-usage",
      "database_id": "YOUR_D1_DATABASE_ID"
    }
  ]
}
```

如果需要 Workers AI 原生 Binding，可再加入：

```jsonc
"ai": { "binding": "AI" }
```

### 3. 初始化并部署

```bash
npx wrangler d1 migrations apply USAGE --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

`ADMIN_TOKEN` 是后台管理员凭据。不要提交到 Git、写进前端代码，或与客户端访问密钥混用。

新增迁移后应再次执行同一条 `d1 migrations apply` 命令。客户端限制达到阈值时返回 HTTP 429；月度 Token 按 UTC 自然月统计，过去 24 小时请求限制采用滚动窗口。Token 限制依据已完成请求的统计，因此并发中的请求可能造成少量超额；如需严格财务上限，仍应同时在上游 Provider 关闭 Pay-as-you-go 或设置消费上限。

### 4. 绑定域名（可选）

不配置域名也可以直接使用 `*.workers.dev` 地址。自定义域名可在 Cloudflare Dashboard 的 Worker **Settings → Domains & Routes** 中添加。

## 数据与安全

- Provider API Key 保存在你自己的 Cloudflare KV 中。
- 客户端访问密钥仅保存哈希，后台不会再次展示完整值。
- Prompt、模型回复与流式内容不会写入统计数据库。
- 用量记录只包含 Provider、模型、Token、状态码、耗时、首字延迟和 TPS 等元数据。
- 建议限制后台访问、定期轮换 `ADMIN_TOKEN`，并为公开部署配置 Cloudflare Access 或 WAF 规则。
- 如果接入收费 Provider，请使用独立、低额度、可随时撤销的 API Key，并在上游设置消费上限和告警；不要将绑定高额余额的主 Key 放入公开网关。

## FAQ / Limitations

### 国内访问国外 API 是否一定不需要代理？

客户端只连接 Cloudflare Worker 或自定义域名，上游请求由 Cloudflare 网络发起，因此在许多国内网络环境中可以直接使用国外 API，无需在客户端配置代理。但实际可用性仍受 Cloudflare 域名与线路、所在地区网络、政策及上游平台限制影响，项目无法保证所有地区和运营商始终可直连。

### 无服务器是否等于不会中断？

不是。Workers 避免了自有 VPS 的硬件、系统和单机网络故障，但仍受 Cloudflare、上游 Provider、配额和区域网络状态影响。

### 免费模型是否无限使用？

不是。免费模型仍可能有每分钟请求数、Token、并发、每日额度或共享容量限制。网关不会绕过上游限流。

### 为什么没有 OpenCode Zen Provider？

OpenCode Zen 的免费额度可能与官方客户端、请求来源或反滥用策略关联。同一 API Key 从官方节点可用，但经第三方 Worker 转发时可能返回 `FreeUsageLimitError`。为避免把不稳定能力包装成可靠功能，当前不提供该预设；若上游规则变得明确，可使用自定义 OpenAI-compatible Provider 测试。

### 为什么部分流式请求的 Token 是估算值？

只有上游返回 `usage` 时才能取得精确 Token。上游未返回时，网关会在不阻塞数据转发的前提下旁路估算，因此统计值适合观察趋势，不应作为账单依据。

## 项目地址

- GitHub: https://github.com/Jiao77/LLMflare
- Gitea: https://gitea.jiao77.com/Jiao77/llmflare

## 鸣谢

- [LINUX DO](https://linux.do/)：真诚、友善、团结、专业的开源与技术讨论社区。
