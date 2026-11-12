# Android build environment: docker build -f build.Dockerfile -t mt5-android-build .
FROM eclipse-temurin:17-jdk-jammy
ENV ANDROID_HOME=/opt/android ANDROID_SDK_ROOT=/opt/android
RUN apt-get update && apt-get install -y --no-install-recommends unzip wget && rm -rf /var/lib/apt/lists/*
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q commandlinetools-linux-*.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm commandlinetools-linux-*.zip
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools" > /dev/null \
 && chmod -R a+rwX $ANDROID_HOME
RUN wget -q https://services.gradle.org/distributions/gradle-8.9-bin.zip -O /tmp/g.zip \
 && unzip -q /tmp/g.zip -d /opt && rm /tmp/g.zip
ENV PATH=/opt/gradle-8.9/bin:$PATH
WORKDIR /src
