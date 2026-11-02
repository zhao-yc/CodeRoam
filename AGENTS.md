# 项目约束

- 说明、错误提示和关键方法注释使用简体中文。
- 手机端是 HBuilderX 类型的 uni-app x 工程，使用 UTS 和 uvue，不使用普通 Vue 或直接启动 Vite 替代。
- 桌面服务和中转使用 Node.js 24。Docker 操作前先确认目标服务器身份。
- 保留 Codex 原有审批和沙箱，不修改安装文件、鉴权文件或原桌面数据库。
- 手机请求只开放协议白名单；令牌不进入 URL、日志和 Git。
- 配对配置和签名放在 .local，使用者自行指定安全备份目录。
- 模拟测试、Web 编译、真实桌面和 Android/iOS 真机验收分别记录。
- 只提交本任务改动，运行 npm run check:privacy 和 npm test。
