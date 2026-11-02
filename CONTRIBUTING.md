# 参与贡献

使用 Node.js 24。提交前运行 `npm ci --ignore-scripts`、`npm run check:privacy` 与 `npm test`。

手机端是 HBuilderX uni-app x 工程，保持 UTS、uvue 与原生平台兼容，不使用普通 Vue 或独立 Vite 工程代替。对手机端改动执行 HBuilderX Web 编译，并分别说明真实桌面、Android/iOS 编译及真机验证范围。

关键方法和说明使用简体中文。不要改变桌面的审批、沙箱或鉴权文件，不在测试中自动操作真实业务会话。

只提交本次变更，不提交 `.local`、构建产物、日志、真实截图或用户配置。提交作者邮箱建议使用 GitHub 提供的 noreply 地址。贡献代码按本项目 MIT 许可证提供。

## 提交与推送隐私检查

克隆后运行 `npm run setup:hooks` 安装本仓库的提交和推送钩子。若已有其他钩子目录，安装脚本会保留它并提示人工整合。

- `npm run check:privacy`：检查当前跟踪文件。
- `npm run check:privacy:staged`：读取实际暂存的 Git 对象，不受未暂存修改影响。
- `npm run check:privacy:history`：检查从当前提交可达的完整历史、作者邮箱与提交说明；中间提交含敏感内容即阻止。

检查失败时先处理问题，不使用 `--no-verify` 或关闭钩子。旧私有仓库只保留备份，不得把它的历史合入此仓库。提交前还须人工核对截图、个人信息与真实会话内容。作者和提交者使用 GitHub noreply 邮箱。

本机可在忽略的 `.local/privacy-policy.json` 配置 `blockedPatterns`（内部或个人标识的正则表达式数组）与 `secretFingerprints`（敏感令牌的 SHA256 指纹数组）。不要把明文令牌写进公开规则或反馈日志。
