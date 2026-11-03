# 自建中转与部署

使用自己的服务器、域名和 TLS。仓库不包含可共享的中转、设备身份或签名材料。

## 凭据初始化

在自己的电脑执行：

```powershell
node scripts/provision.mjs --relay-url wss://relay.example.com/ws --backup-root '<私有备份目录>'
```

初始化成功前不会覆盖已有 `.local/bridge.json`。备份目录须限制访问；电脑、手机令牌分别保管，中转只使用身份与令牌哈希。把自己的 HTTPS 网页来源加入私有 `relay.json` 的 `allowedOrigins` 后再部署。

更换地址时使用 `node scripts/set-endpoint.mjs --relay-url wss://relay.example.com/ws --backup-root '<私有备份目录>'`，它保留原配对令牌并重新备份。

## 中转进程

在自己的服务器安装 Node.js 24 与项目依赖，以专用低权限账号运行：

```sh
node apps/relay/cli.mjs --config /private/config/relay.json --data /private/data --host 127.0.0.1 --port 8787
```

让自己的 HTTPS 网关代理 `/session`、`/ws` 与 `/healthz` 到该进程。WebSocket 升级和 HTTPS POST 都须正常转发。健康检查不能代替经过鉴权的配对与设备隔离验收。

中转和电脑连接服务默认输出脱敏的请求诊断 JSON 行。出现“待处理请求过多”时，可按时间和传输摘要查找积压请求、等待时长及电脑处理阶段，详见[请求积压诊断](request-diagnostics.md)。

## 可选容器部署

仓库提供 `deploy/Dockerfile` 与 `deploy/compose-public.yml`。先核对目标服务器的身份，再在该服务器构建与运行，不要照抄其他人的主机名或目录。

示例 Compose 的配置挂载为 `./config/relay.json`，数据为 `./data`，仅监听服务器回环地址。部署前自行创建配置、限制文件权限，并为容器 UID 1000 准备数据目录。

```sh
hostname
docker build -f deploy/Dockerfile -t codex-mobile-relay:0.1.0 .
docker compose -f deploy/compose-public.yml config --quiet
docker compose -f deploy/compose-public.yml up -d
```

Compose 中相对路径以 Compose 文件位置为基准，请放置对应配置或先复制示例到自己的部署目录。网关样例见 `deploy/Caddyfile.example`，替换域名、静态目录和回环端口后再使用。

## 手机与桌面

Windows 或 Mac 桌面须已登录，桥接运行：`node apps/bridge/cli.mjs --config .local/bridge.json`。手机在连接页面导入自己的 `.local/mobile.json`。

Mac 默认自动发现当前用户的多个官方桌面实例，每套独立 `CODEX_HOME` 使用自己的 `ipc/ipc.sock`，聊天链接定向投递到已核验的进程，再等待原桌面所有者及实时快照。依赖本机 `/usr/bin/python3`；共用同一配置目录的 Mac 多开会暂停连接。详见[多实例说明](multi-instance.md)。`codexHome` 指定默认设备目录，`codexCliPath` 指定随附 CLI；设置 `multiInstance: false` 可回退单实例模式并使用 `ipcSocketPath`。不修改桌面安装文件、鉴权或数据库。Mac 的原生未读同步、归档、永久删除、目标管理及输入预测尚未适配，不能把 Web 编译或模拟测试记为这些功能已通过真机验收。

同一手机连接多台电脑时，为每台电脑生成不同的主机编号和令牌，在中转 `identities` 中分别登记主机，并把它们的编号追加到已有手机身份的 `hostIds`。保留已有手机令牌及其他主机条目，备份后重启中转加载配置；手机重连后即可在电脑列表中切换。不能把另一台电脑的主机编号和令牌直接复制过来启动，否则会替换原电脑连接。

Web 通过 HBuilderX 导出 `apps/mobile/unpackage/dist/build/web`，只将静态产物放到自己的站点。不要上传 `.local`、签名、源码目录中的私有缓存或任何真实会话日志。更新前备份站点和配置，核对服务器、当前版本及健康检查。
