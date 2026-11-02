# 只在核对过身份的200服务器使用，本镜像仅编译未签名包，不挂载私钥。
FROM mcr.microsoft.com/openjdk/jdk:21-ubuntu
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip python3 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/sdk ANDROID_SDK_ROOT=/sdk GRADLE_USER_HOME=/build/gradle-cache
ENV PATH=/sdk/cmdline-tools/latest/bin:/sdk/platform-tools:/opt/gradle/bin:$PATH
RUN curl -fLsS https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip -o /tmp/tools.zip && mkdir -p /sdk/cmdline-tools && unzip -q /tmp/tools.zip -d /sdk/cmdline-tools && mv /sdk/cmdline-tools/cmdline-tools /sdk/cmdline-tools/latest && rm /tmp/tools.zip
RUN yes | sdkmanager --licenses >/dev/null && sdkmanager 'platforms;android-34' 'build-tools;35.0.0' 'platform-tools'
RUN curl -fLsS https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip -o /tmp/gradle.zip && unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-8.14.3 /opt/gradle && rm /tmp/gradle.zip
WORKDIR /build/project
