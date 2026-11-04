# 掌上 Codex

使用自己的手机连接正在运行的 Codex Windows 或 Mac 桌面会话。手机界面使用 **uni-app x / UTS / uvue**，电脑桥接复用现有桌面会话，中转通过 HTTPS 和 WSS 连接两端。

这是社区维护的非官方项目，与 OpenAI 无隶属关系。仓库提供源码和自建中转方案，不提供共享账号、公共中转服务、配对凭据或签名安装包。

## 功能

- 多电脑会话列表、搜索、历史分页及实时消息。
- 新建会话、发送文字、图片和附件、执行中追加指令、停止任务。
- 转发原桌面的审批、问答和目标管理，保留原审批及沙箱边界。
- 前后台恢复、断线重连、请求去重、未知结果核对和设备授权隔离。
- Markdown 展示、外部链接、会话名称同步、折叠注释详情及 Windows 桥接服务托管。
- Electron 电脑管理客户端：查看运行状态、编辑连接与缓存配置、读取生命周期日志和受控重启，详见[桌面管理说明](docs/desktop-manager.md)。

## 环境

- Node.js 24，以及已经登录并正在运行的 Codex Windows 或 Mac 桌面客户端。
- Windows 与 Mac 可自动发现多个桌面实例，详见[多实例连接说明](docs/multi-instance.md)；Mac 需要独立配置目录及本机 Python 3。
- HBuilderX 5.34 或兼容的 uni-app x 工具链。手机端不是普通 Vue 项目。
- 自己控制的中转服务器、HTTPS 域名及安全的凭据备份位置。

桌面桥接依赖非公开稳定协议，桌面版本升级后需要重新验证。源码测试通过不能替代 Android/iOS 真机、真实桌面或弱网环境验收。

## 本地检查

```powershell
npm ci --ignore-scripts
npm run setup:hooks
npm run check:privacy
npm test
```

以上检查不连接真实桌面或中转，不生成签名与配对凭据。`npm run diagnose` 会读取本机桌面状态，诊断输出只留在自己控制的环境。

## 配对并运行

先按 [自建部署说明](docs/self-hosting.md) 部署自己的中转。每套环境生成独立凭据，并使用安全备份目录：

```powershell
node scripts/provision.mjs --relay-url wss://relay.example.com/ws --backup-root '<自己的私有备份目录>'
node apps/bridge/cli.mjs --config .local/bridge.json
```

初始化先备份，再写入 `.local`；已有配对会拒绝覆盖。`.local/relay.json` 包含鉴权哈希，仅部署到自己的中转；`.local/bridge.json` 留在电脑；`.local/mobile.json` 导入自己的手机。三份文件不能提交或公开。

手机工程用 HBuilderX 打开 `apps/mobile`，先在 manifest 编辑界面申请自己的 AppID。本仓库的 AppID 留空，不能复用他人的云账号身份。Web 运行与编译使用 HBuilderX CLI：

```powershell
& $env:HBX_CLI launch web --project "$PWD/apps/mobile" --ui true
& $env:HBX_CLI publish web --project "$PWD/apps/mobile" --webTitle '掌上 Codex'
```

日常开发、运行和重新打包复用固定的 `apps/mobile` 工程。只有需要隔离验证或私有配置时才创建临时工程；用完后停止对应任务，从 HBuilderX 项目列表移除临时工程，并清理临时源码目录。清理前确认目录已不再使用，必要产物和私有文件已妥善保存。

`HBX_CLI` 指向自己的 HBuilderX CLI。原生构建前，将示例包名 `org.example.codexmobile` 替换为自己的包名。签名和打包说明见 [Android 模板](native/android/README.md)。

## 安全与隐私

中转能处理明文会话内容，传输使用 TLS，当前没有应用层端到端加密。只使用自己信任的中转。配对令牌不进入 URL 和日志，模型账号凭据留在桌面端。

安全边界与私有报告方式见 [SECURITY.md](SECURITY.md)，贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，旧功能迁移与隐私审查结果见 [迁移记录](docs/migration-review.md)。不要把真实会话、个人路径、截图、诊断日志或签名文件附到公开 Issue。

## 许可证

本项目采用 [MIT](LICENSE) 许可证。第三方图标保留各自许可证；见 [第三方说明](THIRD_PARTY_NOTICES.md)。Codex、OpenAI 和 DCloud 等名称归各自权利人所有，本许可证不授予相关商标或第三方 SDK 的权利。
