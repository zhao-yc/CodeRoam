# 请求积压诊断

中转和电脑连接服务的 CLI 默认向标准输出写入 JSON 行，`diagnosticsVersion: 1` 表示本版字段。时间统一为 UTC ISO 格式；`session` 区分进程重启，`trace` 将同一请求的中转日志与电脑日志关联。健康检查的 `requestDiagnosticsVersion: 1` 表示中转已启用诊断。嵌入式调用 `createRelay`、`BridgeAgent` 或 `InstanceHub` 时需显式传入 `createRequestDiagnostics`，以便选择自己的输出位置。

## 关键节点

| 事件 | 含义 |
| --- | --- |
| `request.forwarded` | 请求进入中转在途队列，记录发送状态、并发数及发送缓冲字节数 |
| `bridge.received` | 电脑多实例入口收到请求 |
| `bridge.dispatch` | 电脑进入请求处理，记录当前执行中和排队中的请求总数 |
| `bridge.execute` | 开始执行，`queueWaitMs` 为分派至执行的等待时间，`lockQueued` 表示曾等待会话锁 |
| `bridge.completed` | 电脑处理结束，记录耗时、错误类别及结果是否需要核对 |
| `bridge.sent` / `bridge.dropped` | 回执已交给发送通道，或因连接变化未发送；交给通道不代表中转已经收到 |
| `request.completed` | 中转收到有效回执，记录耗时和手机回执发送状态 |
| `request.busy` | 全局在途请求达到 1024 或当前手机连接达到 16 |
| `request.timeout` / `request.cancelled` | 请求等待超时，或连接断开、实例换代结束等待 |
| `response.ignored` | 回执来源或代次不匹配，原请求仍需等待有效回执或超时 |
| `response.late` | 未找到在途记录，可能已超时、断线清理，或属于不占在途名额的后台退订 |
| `request.rejected` | 请求未转发，包括限流、未授权、电脑离线和参数校验失败 |
| `connection.open` / `connection.close` / `connection.warning` | 连接建立、标准关闭码及已知警告类别 |

限流日志包含当前手机连接最多 16 条积压明细，以及全局全部方法计数和最早 16 条明细。明细含等待时长、匿名电脑/手机身份/聊天编号，`view: prefetch` 标记静默预加载，`activate: true` 标记同步切换电脑聊天。`pendingMobile` 按 WebSocket 连接统计，`device` 按配对身份匿名化；同一配对的多个网页连接可由 `connection` 区分。

排查时先找到 `request.busy` 的时间和积压 `trace`，再查对应的中转转发与电脑接收、执行、回执记录。只有转发、没有电脑接收，需要结合网络及电脑日志判断；已接收但迟迟没有 `bridge.execute`，重点看路由核验或会话锁；已经执行而没有完成，重点看桌面接口；电脑已发送而中转未完成，重点看连接变化、迟到或代次不匹配。日志缺失或日志已轮转也会导致记录不完整，不能仅凭缺少一行就确定根因。

## 隐私、留存和验证

不记录请求/响应正文、参数对象、搜索词、标题、目录、服务器地址、令牌、鉴权头、原始请求编号及原始错误消息。电脑、配对身份和聊天编号使用每个进程随机密钥的 HMAC 摘要，重启后变化；跨进程仅使用中转生成的随机传输编号摘要关联。只输出已知方法、视图和错误码，其余错误码归为 `OTHER`。诊断失败不会改变业务结果、重试、审批或结果未知语义。

容器通过已有 Compose 日志驱动留存，示例配置每文件 10 MB、最多 3 个文件。电脑通过现有托管服务的标准输出日志留存；这些日志仍属于私有运行资料，限制访问并按本地留存策略归档，禁止提交到公开仓库。诊断不额外创建持久化请求队列，也不会补回升级前的明细。`node --test tests/request-diagnostics.test.mjs` 使用合成 WebSocket 请求覆盖限流、释放、超时、迟到、断线、会话锁和日志故障；不代表真实设备或真实桌面完整验收。
