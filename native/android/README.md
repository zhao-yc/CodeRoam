# Android 离线模板

这里仅提供源码模板，不包含 SDK、签名、AppID 或安装包。使用前须申请自己的 DCloud AppID，在 `apps/mobile/manifest.json` 填写，并同步模板与签名脚本中的示例包名 `org.example.codexmobile`。

推荐先使用 HBuilderX 标准 Android 构建流程。旧离线模板按 5.26 SDK 结构准备，不能直接认为与较新 HBuilderX/SDK 兼容；升级时需按 DCloud 官方说明同步依赖并验证完整原生构建。

生成签名前设置 `HBUILDERX_HOME` 和 `CODEX_MOBILE_BACKUP_ROOT`，然后运行 `node scripts/prepare-android.mjs`。脚本只在本机生成独立签名，先备份再保存打包配置；不在 CI 或公开仓库生成、保存签名材料。

离线工程使用 `scripts/prepare-android-offline.mjs --resources <资源目录> --sdk <SDK目录> --output <不存在的新工程目录>`。签名使用 `scripts/sign-android-local.mjs --input <未签名APK>`；脚本从 `.local/android/pack.json` 读取自己的私有材料。构建、签名成功与真机验收须分别记录。
