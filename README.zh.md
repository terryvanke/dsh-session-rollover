# dsh-session-rollover

[English](README.md) | 简体中文

> 为长时间运行的 DeepSeek Harness Agent 自动接力到新 Session。

适配 DeepSeek Harness `0.1.7-rc.1` 的新 Session 任务接力插件。它在上下文耗尽之前创建全新 Session，保存 Markdown 与 JSON Checkpoint，并让新 Agent 自动继续任务。恢复时以实际文件系统为准。

这是独立的社区插件，并非 DeepSeek 官方组件。它适用于通过 DSH 接入、能提供准确上下文窗口信息的模型。GLM-5.1 的 200K 窗口只是默认配置场景；使用其他模型时，应让 Provider 报告实际窗口，或显式设置回退窗口值。插件不能直接用于 DSH 以外的所有模型运行时。

## 功能亮点

- 每次 Agent 请求前检查 token 压力，到硬阈值前自动接力。
- 持久保存 Markdown 与 JSON Checkpoint，在不复制旧聊天历史的新 Session 中继续任务。
- 在宿主 API 支持的范围内保留工作区、模型选择与具名权限预设。
- 进程重启后恢复未完成的接力事务，并与官方 compaction 协同。
- LLM 补充 Checkpoint 失败时，使用确定性回退内容。

## 原因与架构

官方 compaction 能压缩同一个 Session 的旧历史，但长期编码任务仍可能多次压缩或遇到上下文溢出。本插件增加独立的 Session 接力：`ContextMonitor → RolloverPolicy → CheckpointGenerator → CheckpointStore → SessionRolloverManager → FreshSessionCreator → CheckpointInjector → AutoResumeManager`。

每次 `agent/pre-step` 使用官方 `ctx.tokenMeter` 测量上下文，再计算软阈值与硬阈值。硬阈值公式为 `min(floor(contextWindow × hardRatio), contextWindow − outputReserve − safetyReserve)`。硬阈值禁止旧 Session 继续发普通请求。插件先写确定性 Checkpoint，再尝试 LLM 补充；Web 路径使用公开的 `sessionController.create()` 组合预设并调用 `ctx.agents.create()`，其他 Runtime 直接使用 `ctx.agents.create()`。新 Session 没有旧历史种子，使用 `inject()` 和 `followup()` 继续工作。`agent/request-error` 负责溢出接力。

状态包括 `NORMAL`、`ARMED`、`CHECKPOINTING`、`ROLLOVER_PENDING`、`CREATING_SESSION`、`RESUMING`、`COMPLETED`、`FAILED`、`EMERGENCY_ROLLOVER`。Session 锁、事务 ID 和预先生成的目标 ID 用于避免重复创建。

## 安装与启用

需要 Node.js、pnpm 和 DSH `0.1.7-rc.1`。克隆仓库后运行：

```powershell
git clone https://github.com/terryvanke/dsh-session-rollover.git
cd dsh-session-rollover
pnpm install
pnpm run build
dsh plugin --profile web add .
```

如果 `dsh` 不在 PATH 中，可通过 Node.js 运行已安装的 `@deepseek-ai/dsh/lib/bin.js`。包内的 `dsh.bundle` 会自动把 `cordis.patch.yml` 加入 Web profile。用 `dsh --profile web --dump-config` 检查最终配置。已有 Web profile 中无效的旧补丁条目需要先修复。Profile 机制详见[官方插件安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 配置与 GLM 200K 推荐值

默认 `context.windowTokens=200000`、软阈值 `0.65`、硬阈值 `0.72`、输出预留 `32000`、安全预留 `24000`；实际硬阈值为约 `144000` tokens。优先使用模型适配器报告的窗口和输出上限。其他配置位于 `src/config.ts`：Checkpoint 内容及重试、最大接力次数、最短间隔、工作区和模型保留、溢出回退、存储目录、日志通知。DSH profile 补丁会整体替换 `config`，自定义时应写全配置对象。

## Checkpoint、接力与重启恢复

默认写入 `<workspace>/.dsh/rollover/<chain-id>/chain.json`，以及 `session-001.md/json` 等文件。Markdown 面向新模型；JSON 保存 Session 链、任务、文件、错误、决策和唯一下一步。采用临时文件、文件同步、重命名写入。进程重启后检查未完成事务，并复用预定目标 ID；已持久化的 Session 通过 `ctx.agents.resume()` 恢复。新 Agent 先检查 `git status`、`git diff --stat` 和关键文件，再执行下一步。

## 与官方 Compaction 协同

保留 Agent 预设中的 `@deepseek-ai/dsh-compaction-basic`。官方实现的默认比例为 80%，但有效阈值还受模型输出预留及默认 65,536 tokens headroom 限制，因此 200K 模型可能在 rollover 之前压缩。它还会对规范化上下文溢出错误有限重试。本插件可按 `rolloverAfterCompactions` 计数在软阈值接力；硬阈值始终优先。

## 已知限制与排障

- 当前公开 API 没有稳定的 Web 自动聚焦或 Toast 接口；V1 输出结构化主机日志，不自动切换浏览器 Session。
- Web 路径通过公开 Session Controller 组合 Agent 预设，并恢复模型选择和具名权限预设；任意自定义 Agent setup 回调无法通用复制，`custom` 权限状态会停止接力。运行中的一次性子 Agent 无法通过公开 Agent API 重新接回父工具结果，插件会跳过这类 Session，由官方 compaction 继续处理；要实现自动接力仍需专用子 Agent 集成。
- 确定性回退使用当前版本已标记 deprecated 的 `Session.snapshotEvents()`；后续迁移到 session-query。
- 重启能避免重复创建目标 Session；极端时序下可能重复排队一次 continuation。新 Agent 必须核对真实文件状态。
- E2E 测试使用模拟 Agent，不调用真实 GLM。
- 如出现 `patch: entry ... not found`，检查 Web profile 的旧补丁 ID；如插件未激活，检查 `dsh.bundle` 和 `--dump-config`。

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
