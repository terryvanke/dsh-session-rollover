# dsh-session-rollover

[English](README.md) | 简体中文

> DeepSeek Harness 自动会话接力，以及 TRAE、WorkBuddy 等 MCP Agent 的任务检查点接力。

适配 DeepSeek Harness `0.2.0-rc.1`、`0.2.0-rc.2` 和 `0.2.1-alpha.2` 的新 Session 任务接力插件。它在上下文耗尽之前创建全新 Session，保存 Markdown 与 JSON Checkpoint，并让新 Agent 自动继续任务。恢复时以实际文件系统为准。

这是独立的社区插件，并非 DeepSeek 官方组件。`0.2.0` 新增独立 MCP stdio 服务，不需要安装 DSH 宿主，即可在 TRAE、WorkBuddy 及其他支持本地 MCP 的 Agent 中保存和恢复任务。DSH 自动接力仍适用于能提供准确上下文窗口信息的模型。GLM-5.1 的 200K 窗口只是 DSH 的默认配置场景；使用其他模型时，应让 Provider 报告实际窗口，或显式设置回退窗口值。

| 接入方式 | 保存与恢复任务 | 自动监测上下文 | 自动创建新会话并续跑 |
| --- | --- | --- | --- |
| DeepSeek Harness 插件 | 支持 | 支持 | 支持，受宿主 API 限制 |
| TRAE / WorkBuddy 的 MCP | 支持，也可在两者间接力 | 无通用接口 | 由用户或客户端创建会话，再加载任务 |
| 其他本地 MCP 客户端 | 使用相同三个工具 | 无通用接口 | 由客户端控制 |

接入方式依据[TRAE 官方 MCP 文档](https://docs.trae.cn/ide_add-mcp-servers)和[WorkBuddy 官方 MCP 文档](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)。协议测试覆盖独立客户端进程和新旧 MCP 握手；不等同于逐一实测客户端界面。

## TRAE、WorkBuddy 和其他 MCP Agent

MCP 服务运行需要 Node.js 20 或更新版本。源码构建使用下文 DSH 开发环境的 Node.js 版本，执行 `pnpm install --frozen-lockfile` 和 `pnpm run build`；独立入口为 `dist/mcp/cli.js`。已打包的 `.tgz` 可安装到独立目录，MCP 入口无需加载 DSH，DSH peer dependencies 对此入口是可选的。

复制对应配置：[TRAE](examples/trae.mcp.json)、[WorkBuddy](examples/workbuddy.mcp.json)。将示例中的两个路径分别改成插件目录和需要接力的项目目录。必须显式设置 `--workspace`，避免误用客户端的启动目录；两个客户端使用相同目录才能共享任务。

```json
{
  "mcpServers": {
    "session-rollover": {
      "command": "node",
      "args": ["E:/GitHub/dsh-session-rollover/dist/mcp/cli.js", "--workspace", "E:/Projects/my-project"]
    }
  }
}
```

- **TRAE**：在「设置 → MCP → 添加 → 手动添加」粘贴配置，也可启用项目级 MCP 后合并到 `.trae/mcp.json`。在使用的智能体中启用该服务。TRAE 支持 `${workspaceFolder}`，可用于代替项目目录。
- **WorkBuddy**：在「插件 → MCP 服务器 → 配置 MCP」合并配置；项目级文件为 `<项目>/.workbuddy/mcp.json`，用户级文件为 `~/.workbuddy/mcp.json`。需要允许自定义 MCP 和对应工具。stdio 配置也见[官方连接器开发文档](https://open.workbuddy.cn/en/docs/connector)。
- **其他客户端**：选择本地 stdio MCP，使用同样的命令和参数；配置文件位置以客户端文档为准。

`node` 必须在客户端的 PATH 中，否则将 `command` 改为 Node 可执行文件的绝对路径。带空格的项目或脚本路径各占一个 `args` 元素，不能把完整命令塞进 `command`。保留已有 MCP 配置，仅增加 `session-rollover` 条目。

将 [AGENT_RULES.md](docs/AGENT_RULES.md) 放入客户端的 Agent 指令或项目规则，使 Agent 在里程碑和换会话前调用保存工具。规则不能保证拦截客户端的自动压缩。也可以直接说「保存当前任务检查点」；新会话说「恢复任务 `<taskId>`，先检查工作区再继续」。

### 三个工具

| 工具 | 用途 |
| --- | --- |
| `rollover_save` | 保存完整任务快照，返回 `taskId`、`checkpointId` 和下一步；后续保存复用 `taskId` |
| `rollover_list` | 列出每个任务的最新快照，包括已完成任务 |
| `rollover_load` | 按 `taskId` 恢复；可用 `checkpointId` 指定历史快照，返回检查点和接力指令 |

首次保存示例：

```json
{
  "originalGoal": "修复登录问题，保留现有接口",
  "currentGoal": "验证登录修复",
  "currentWork": "已修改登录逻辑，尚未运行测试",
  "nextAction": "运行现有登录测试",
  "requirements": ["保留现有接口"],
  "completed": ["修改登录逻辑"],
  "pending": ["运行测试"]
}
```

每次保存都是完整快照，省略的列表为空；`originalGoal` 必须保持原值，后续用户要求记录在 `requirements` 和 `currentGoal`。`status` 默认为 `in-progress`，完成时设为 `completed`。四个必填文本字段最长各 12,000 字符；列表最多各 12 项，每项 2,000 字符。请只保留接力所需事实。

MCP 快照保存为 `<workspace>/.session-rollover/<taskId>.<checkpointId>.json/md`。JSON 保存完整事实，Markdown 会缩短长内容并指出完整 JSON 文件。每次写入独立文件，JSON 的原子重命名表示保存成功，旧快照不被覆盖。同时保存的两个快照均保留，默认按保存时间及 ID 选最新一份，不自动合并分歧。损坏快照会明确报错，应先备份并修复或移走报错文件，不能当作空任务覆盖。

将 `.session-rollover/` 加入实际项目的 `.gitignore`。检查点是本地明文，不要保存密钥；服务不主动联网，但客户端可能将恢复内容发送给其模型。目录必须是受信任的本地项目，目录检查不替代操作系统权限或沙箱。服务只采集 Git 状态，不修改源码；它不保存私有聊天数据库、后台进程、模型权限或客户端 UI。MCP 和 DSH 使用各自的存储目录；MCP 不直接导入 DSH Session 事务。

## 功能亮点

- 每次 Agent 请求前检查 token 压力，到硬阈值前自动接力。
- 持久保存 Markdown 与 JSON Checkpoint，在不复制旧聊天历史的新 Session 中继续任务。
- 在宿主 API 支持的范围内保留原始项目、当前工作目录、模型选择与具名权限预设。
- 进程重启后恢复未完成的接力事务，并与官方 compaction 协同。
- LLM 补充 Checkpoint 失败时，使用确定性回退内容。

## 原因与架构

官方 compaction 能压缩同一个 Session 的旧历史，但长期编码任务仍可能多次压缩或遇到上下文溢出。本插件增加独立的 Session 接力：`ContextMonitor → RolloverPolicy → CheckpointGenerator → CheckpointStore → SessionRolloverManager → FreshSessionCreator → CheckpointInjector → AutoResumeManager`。

每次 `agent/pre-step` 使用官方 `ctx.tokenMeter` 测量上下文，再计算软阈值与硬阈值。硬阈值公式为 `min(floor(contextWindow × hardRatio), contextWindow − outputReserve − safetyReserve)`。硬阈值禁止旧 Session 继续发普通请求。插件先写确定性 Checkpoint，再尝试 LLM 补充；Web 路径使用公开的 `sessionController.create()` 组合预设并调用 `ctx.agents.create()`，其他 Runtime 直接使用 `ctx.agents.create()`。新 Session 没有旧历史种子，使用 `inject()` 和 `followup()` 继续工作。`agent/request-error` 负责溢出接力。

状态包括 `NORMAL`、`ARMED`、`CHECKPOINTING`、`ROLLOVER_PENDING`、`CREATING_SESSION`、`RESUMING`、`COMPLETED`、`FAILED`、`EMERGENCY_ROLLOVER`。Session 锁、事务 ID 和预先生成的目标 ID 用于避免重复创建。

## DSH 安装与启用

需要 Node.js `^22.19.0 || >=24.0.0`、pnpm 和 DSH `0.2.0-rc.1`、`0.2.0-rc.2` 或 `0.2.1-alpha.2`。克隆仓库后运行：

```powershell
git clone https://github.com/terryvanke/dsh-session-rollover.git
cd dsh-session-rollover
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add .
```

如果 `dsh` 不在 PATH 中，可通过 Node.js 运行已安装的 `@deepseek-ai/dsh/lib/bin.js`。包内的 `dsh.bundle` 会自动把 `cordis.patch.yml` 加入 Web profile。用 `dsh --profile web --dump-config` 检查最终配置。已有 Web profile 中无效的旧补丁条目需要先修复。Profile 机制详见[官方插件安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 配置与 GLM 200K 推荐值

默认 `context.windowTokens=200000`、软阈值 `0.65`、硬阈值 `0.72`、输出预留 `32000`、安全预留 `24000`；实际硬阈值为约 `144000` tokens。优先使用模型适配器报告的窗口和输出上限。其他配置位于 `src/config.ts`：Checkpoint 内容及重试、最大接力次数、最短间隔、工作区和模型保留、溢出回退、存储目录、日志通知。`includeRecentMessages` 与 `includeToolResults` 设为 `0` 时不保留对应近期记录。DSH profile 补丁会整体替换 `config`，自定义时应写全配置对象。

## Checkpoint、接力与重启恢复

默认写入 `<workspace>/.dsh/rollover/<chain-id>/chain.json`，以及 `session-001.md/json` 等文件。Markdown 面向新模型；JSON 保存 Session 链、任务、文件、错误、决策和唯一下一步。采用临时文件、文件同步、重命名写入。进程重启后检查未完成事务，并复用预定目标 ID；已持久化的 Session 通过 `ctx.agents.resume()` 恢复。新 Agent 先检查 `git status`、`git diff --stat` 和关键文件，再执行下一步。转交的用户消息会直接触发续跑，不再额外排队一次合成续跑消息；溢出接力成功后，旧 Session 不再重试模型请求。

在 `0.2.1-alpha.2` 中，通过可选的 `workingDirectory` 服务读取当前执行目录。新 Session 的 header 保留原始项目，恢复具名权限后再设置当前工作目录；Checkpoint 仍存储在原始项目下，便于重启恢复。没有 `originalCwd` 字段的旧 Checkpoint 仍可读取。

## 与官方 Compaction 协同

保留 Agent 预设中的 `@deepseek-ai/dsh-compaction-basic`。官方实现的默认比例为 80%，但有效阈值还受模型输出预留及默认 65,536 tokens headroom 限制，因此 200K 模型可能在 rollover 之前压缩。它还会对规范化上下文溢出错误有限重试。本插件可按 `rolloverAfterCompactions` 计数在软阈值接力；硬阈值始终优先。

## 已知限制与排障

- 当前公开 API 没有稳定的 Web 自动聚焦或 Toast 接口；V1 输出结构化主机日志，不自动切换浏览器 Session。
- Web 路径通过公开 Session Controller 组合 Agent 预设，并恢复模型选择和具名权限预设；任意自定义 Agent setup 回调无法通用复制，`custom` 权限状态会停止接力。运行中的一次性子 Agent 无法通过公开 Agent API 重新接回父工具结果，插件会跳过这类 Session，由官方 compaction 继续处理；要实现自动接力仍需专用子 Agent 集成。
- 确定性回退使用当前版本已标记 deprecated 的 `Session.snapshotEvents()`；后续迁移到 session-query。
- 重启能避免重复创建目标 Session；极端时序下可能重复排队一次 continuation。新 Agent 必须核对真实文件状态。
- E2E 测试覆盖真实 Cordis、Agent 循环、Session 存储和 token meter，模型响应由本地测试适配器提供；另有模拟多 Session 接力测试，不调用真实 GLM。
- 如出现 `patch: entry ... not found`，检查 Web profile 的旧补丁 ID；如插件未激活，检查 `dsh.bundle` 和 `--dump-config`。

开发依赖与锁文件使用 `0.2.1-alpha.2`，兼容检查同时覆盖 `0.2.0-rc.1` 和 `0.2.0-rc.2`。Alpha 版本属于上游预览版本。

## 开发与测试

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:e2e
pnpm run build
```

## V2

增加 Session Chain UI、稳定的自动聚焦、preset setup 集成、公开查询服务读取，以及具备事务保证的 continuation 去重。

## 参与贡献与许可证

欢迎提交 Issue 和 Pull Request。提交前请运行“开发与测试”中的检查。本项目采用 [MIT 许可证](LICENSE)。
