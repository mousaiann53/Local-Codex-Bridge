# 更新日志

本文件只记录当前公共仓库 Git 历史中可以核验的事实。当前公开版本为 **V2.1.1**；公共历史中没有单独的 V2.1.0 发布记录。

## 未发布

- 允许同一 MCP stdio 进程在 `protocolVersion` 与 capabilities 保持一致、且 `clientInfo.name` 未变化时刷新 `clientInfo` 的版本、标题和其他描述性元数据，避免宿主刷新元数据后因 `clientInfo differs` 锁死后续工具调用。
- 不同客户端名称、协议版本变化和 capabilities 变化继续失败关闭；新增回归测试覆盖 clientInfo 元数据刷新与客户端名称变化边界。

## V2.1.1（2026-08-11）

- 完成监督与控制边界加固：会改变原生状态的请求若在发送后等待确认超时，会明确报告结果为 `UNKNOWN`，Bridge 不会自动重试、取消或推断结果。
- 拒绝仍在处理中的重复请求 ID，同时不干扰原请求的取消、清理及后续 ID 复用。
- 收紧 `codex_respond` 的前向兼容边界：只响应具有明确原生契约的已支持方法；未知方法保持已清理、可观察和 pending 状态，并且不发送响应。
- 加强 app-server 与 MCP 回归测试，覆盖变更请求确认超时、原生写入仍 pending、未知请求、已知用户输入响应和重复活动请求 ID 等边界。
- 将项目包版本、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.1`。

## 可核验的公共历史

- `ccd98f2`：V2.1.1 公共监督边界加固。
- `c28fc37`：中文优先的 README 与 `AGENTS.md` 公共文档完善。
- `8996398`：Local Codex Bridge 初始公共基线。

以上提交日期均为 2026-08-11。
