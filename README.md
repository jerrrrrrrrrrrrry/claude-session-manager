# Claude Session Manager — 改造文档

本文档由 review team（3 名 reviewer 并行审查）生成。请组建 Agent Team 按优先级逐项修复。

项目目录：`/mnt/f/claude/claude-session-manager/`
端口：3001（3000 已被占用）

---

## 一、CRITICAL — 必须修复

### C1. src/data-reader.js 是死代码，server.js 重复实现

`server.js` 完全没有 `require('./src/data-reader.js')`，所有数据读取逻辑在 server.js 中重新实现了一遍，而且实现质量更差（无 JSDoc、无错误日志）。

**要求**：
- 删除 server.js 中重复的数据读取函数（getProjects, getSessionDetail, getHistoryCommands, safeReadJSONL 等）
- 改为 `const dataReader = require('./src/data-reader.js')`
- search 和 stats 功能在 data-reader.js 中补充
- server.js 只负责路由和 HTTP 响应

### C2. 路径解码逻辑根本性错误

当前代码（server.js:359, 466; data-reader.js:63, 153, 236）：
```js
proj.replace(/-/g, "/")
```
把所有 `-` 替换成 `/`。路径中本身的 `-` 也被替换了，比如 `/home/user/my-project` → `/home/user/my/project`。

**要求**：从 session JSONL 文件的 `cwd` 字段中提取真实项目路径，建立 `encodedDir → realPath` 的映射缓存。首次扫描时读取每个项目下第一个 session 文件的第一条消息获取 `cwd`。这是唯一可靠的解码方式。

### C3. Session 预览显示系统噪音

session 列表中的预览文本（preview）取的是第一条 user 消息的 content，但实际数据中第一条 user 消息往往是系统生成的噪音：
- `<local-command-caveat>Caveat: The messages below...`
- `<command-name>/clear</command-name>`
- `<local-command-stdout>...</local-command-stdout>`

用户看到的 session "标题" 全是这些无意义的 XML 标签。

**要求**：
- 跳过 `isMeta === true` 的消息
- 跳过 content 以 `<local-command-` 或 `<command-name>` 开头的消息
- 找到第一条真正的用户输入作为预览
- 同时提取 session 的 `slug` 字段（如 `"linear-stirring-hoare"`）作为辅助标识

### C4. Session 详情页渲染严重损坏

`renderMessage()` 函数（index.html:849-883）有多个致命问题：

1. **user 消息 content 可能是 string 不是 array**：line 855 `msg.message.content.find(...)` 对 string 类型会崩溃
2. **assistant 消息优先显示 thinking 而非 text**：line 859 `textBlock?.thinking || textBlock?.text` 把内部思考链展示给用户，而不是实际回复
3. **所有噪音消息都被渲染**：file-history-snapshot、hook_progress、turn_duration、bash_progress 等内部消息全部显示为 JSON 块
4. **tool_use 完全不可见**：assistant 消息中的工具调用（Bash、Read、Edit 等）是 session 最有价值的内容，但完全没有渲染

**要求**：
- 消息过滤：只显示 `type: "user"`（非 meta）、`type: "assistant"`（有实际 text content）
- user 消息：兼容 string 和 array 两种 content 格式
- assistant 消息：显示 `type: "text"` 的 content block，`type: "thinking"` 折叠隐藏
- tool_use：显示为可折叠的工具调用摘要（工具名 + 输入摘要 + 输出摘要）
- 添加 "显示全部" 开关，用于调试时查看所有原始消息

### C5. 路径遍历安全漏洞

`/api/sessions/:project/:sessionId` 路由（server.js:93-98）直接用 `req.params` 拼接文件路径，没有校验：
```js
const sessionPath = path.join(PROJECTS_DIR, projectName, `${sessionId}.jsonl`);
```
攻击者可以用 `../../etc/passwd` 读取任意文件。

**要求**：校验 resolved path 必须在 PROJECTS_DIR 内：
```js
const resolved = path.resolve(PROJECTS_DIR, projectName, `${sessionId}.jsonl`);
if (!resolved.startsWith(PROJECTS_DIR)) return res.status(400).json({...});
```

---

## 二、HIGH — 高优先级改进

### H1. byDay 统计的 token 值全部为 0

API 测试确认：`/api/stats` 返回的 `byDay` 数组中，所有天的 `tokens`、`inputTokens`、`outputTokens` 都是 0，但 session 数是正确的。

根因：server.js:429-440 创建了 `byDay[day]` 对象但从未累加 token 值。

**要求**：在创建 byDay 条目的同一个循环中累加 token：
```js
if (msg.timestamp && msg.message?.usage) {
  const day = msg.timestamp.substring(0, 10);
  if (!byDay[day]) byDay[day] = { date: day, tokens: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
  byDay[day].inputTokens += msg.message.usage.input_tokens || 0;
  byDay[day].outputTokens += msg.message.usage.output_tokens || 0;
  byDay[day].tokens += (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0);
}
```

### H2. 全部同步 I/O，无缓存，性能极差

所有 API 请求都用 `readFileSync` / `readdirSync`，每次请求重新读取所有文件。`/api/stats` 甚至读取所有文件两遍（lines 412-442 计算 token，lines 447-462 再读一遍计算 session/day）。

**要求**：
- 启动时扫描一次，建立内存索引（session 元数据缓存）
- 用 chokidar（已在 package.json 中但从未使用）监听文件变化，增量更新缓存
- API 请求从缓存读取，不再每次读磁盘
- `/api/stats` 的两次遍历合并为一次

### H3. Session 详情页查找逻辑低效

`renderSessionDetail()`（index.html:797-808）遍历所有 project 逐个发 HTTP 请求查找 session，而 `sessions` 数组中已经有 `projectId` 信息。

**要求**：优先从 `sessions.find(s => s.sessionId === id)` 获取 projectId，直接请求。遍历所有 project 作为 fallback。

### H4. messageCount 包含所有噪音消息

一个实际只有 ~300 轮对话的 session 显示 "2569 messages"，因为计数包含了 file-history-snapshot、hook_progress、turn_duration 等内部消息。

**要求**：只计算 `type: "user"` 和 `type: "assistant"` 的消息数量（排除 `isMeta: true`）。

### H5. Stats 页面 byProject 排序 mutation bug

index.html:736 和 963：
```js
topProjects.sort((a, b) => b.tokens - a.tokens)
```
`.sort()` 原地修改数组，导致 "按 session 数排序" 的图表实际上也按 token 排序了。

**要求**：使用 `[...array].sort()` 或 `.slice().sort()` 避免 mutation。

---

## 三、MEDIUM — 中优先级改进

### M1. Session 标题应显示有意义的内容

当前显示 `Session 681bffd2...`（UUID 前 8 位），毫无意义。

**要求**：
- 主标题：第一条真实用户消息（截断 60 字符）
- 副标题：session slug（如 `linear-stirring-hoare`，来自 JSONL 的 `slug` 字段）
- 如果都没有，才 fallback 到 UUID

### M2. 缺少关键元信息显示

Session 数据中有很多有价值的字段没有展示：

| 字段 | 来源 | 当前状态 |
|------|------|----------|
| model | assistant 消息的 `message.model` | 未显示 |
| Claude Code 版本 | 消息的 `version` 字段 | 未显示 |
| Git 分支 | 消息的 `gitBranch` 字段 | 未显示 |
| 工作目录 | 消息的 `cwd` 字段 | 未显示 |
| Session 时长 | 首尾消息时间差 | 未计算 |
| Team 信息 | 消息的 `teamName`/`agentName` 字段 | 未显示 |

**要求**：在 session 卡片和详情页头部显示这些信息。

### M3. 搜索结果中 project 路径格式不一致

API 测试发现：搜索结果中有的用 `/mnt/f/claude/hotpulse`（斜杠格式），有的用 `-mnt-f-claude-hotpulse`（横杠格式）。`/api/history` 用斜杠格式，`/api/search` 混用。

**要求**：所有 API 响应中的 project 路径统一使用解码后的真实路径。

### M4. 分页功能不完整

当前 `/api/sessions` 的 `limit` 参数实际上是限制每个 project 读取的文件数，不是总数。没有 `offset`/`page` 参数，无法翻页。

**要求**：
- 添加 `page` 和 `limit` 参数（默认 page=1, limit=50）
- 返回 `meta: { total, page, limit }` 用于前端分页
- 前端添加分页控件

### M5. CORS 配置过于宽松

`Access-Control-Allow-Origin: *` 允许任何网站读取本地 Claude session 数据。

**要求**：限制为 `localhost` 来源：
```js
const origin = req.headers.origin;
if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
  res.header('Access-Control-Allow-Origin', origin);
}
```

### M6. 导航体验差

- Back 按钮固定跳转到 sessions 列表，不管你从哪来的（搜索结果、dashboard）
- 没有 URL 路由，刷新页面回到 dashboard，浏览器前进后退不工作
- 选择 project 后切换 tab 再切回来，project 选择丢失

**要求**：
- 用 `history.pushState` 实现 URL 路由（如 `#/sessions/project/sessionId`）
- 维护 previousView 变量，back 按钮返回上一个视图
- project 选择状态在 tab 切换时保持

### M7. 搜索结果不高亮匹配文本

搜索结果只显示原文，没有高亮匹配的关键词。

**要求**：在 `escapeHtml` 之后，用 `<mark>` 标签包裹匹配文本。

### M8. chokidar 依赖未使用

package.json 中声明了 chokidar 依赖但从未 import。

**要求**：如果实现了 H2（缓存 + 文件监听），则使用 chokidar。否则从 dependencies 中移除。

---

## 四、架构建议

### A1. 推荐的文件结构

```
claude-session-manager/
├── server.js              # Express 路由 + HTTP 服务（精简，只做路由）
├── src/
│   ├── data-reader.js     # 数据读取（已有，需补充 search/stats）
│   ├── cache.js           # 内存缓存 + chokidar 文件监听
│   └── utils.js           # 工具函数（路径解码、格式化等）
├── public/
│   └── index.html         # 前端 SPA
└── package.json
```

### A2. 数据流

```
启动 → 扫描所有 session 文件 → 建立内存索引（元数据 + token 统计）
     → chokidar 监听 ~/.claude/projects/ 变化 → 增量更新索引

API 请求 → 从内存索引读取 → 只有 session 详情才读原始文件
```

### A3. 消息类型过滤规则

JSONL 中的消息类型和处理方式：

| type | 条件 | 处理 |
|------|------|------|
| user | `isMeta !== true`，content 非系统标签 | ✅ 显示 |
| user | `isMeta === true` 或 content 是 `<local-command-*>` | ❌ 隐藏 |
| assistant | content 包含 `type: "text"` block | ✅ 显示 text |
| assistant | content 包含 `type: "thinking"` block | 🔽 折叠显示 |
| assistant | content 包含 `type: "tool_use"` block | 🔽 折叠显示工具名+摘要 |
| progress | `data.type === "hook_progress"` | ❌ 隐藏 |
| progress | `data.type === "bash_progress"` | ❌ 隐藏 |
| system | `subtype === "turn_duration"` | ❌ 隐藏 |
| system | `subtype === "compact_boundary"` | ❌ 隐藏 |
| file-history-snapshot | — | ❌ 隐藏 |

提供 "显示全部原始消息" 开关用于调试。

---

## 五、实施优先级

按以下顺序实施，每完成一组验证一次：

**第一批（修复致命问题）**：C1 + C2 + C3 + C4 + C5
**第二批（修复数据问题）**：H1 + H2 + H4 + H5
**第三批（体验优化）**：M1 + M2 + H3 + M6
**第四批（完善功能）**：M3 + M4 + M5 + M7 + M8
