# 参与贡献

使用 Node.js 24。提交前运行 `npm ci --ignore-scripts`、`npm run check:privacy` 与 `npm test`。

手机端是 HBuilderX uni-app x 工程，保持 UTS、uvue 与原生平台兼容，不使用普通 Vue 或独立 Vite 工程代替。对手机端改动执行 HBuilderX Web 编译，并分别说明真实桌面、Android/iOS 编译及真机验证范围。

关键方法和说明使用简体中文。不要改变桌面的审批、沙箱或鉴权文件，不在测试中自动操作真实业务会话。

只提交本次变更，不提交 `.local`、构建产物、日志、真实截图或用户配置。提交作者邮箱建议使用 GitHub 提供的 noreply 地址。贡献代码按本项目 MIT 许可证提供。
