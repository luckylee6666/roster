#!/usr/bin/env bash
# 构建 Roster 远程安卓安装包（APK）。只用 Android SDK 自带的命令行工具，不走 Gradle、不联网。
# 产物：mobile-android/build/roster-remote.apk（用本机 debug 证书签名，适合自己侧载安装）。
set -euo pipefail

cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
PLATFORM="${PLATFORM:-$SDK/platforms/android-35/android.jar}"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
VERSION_NAME="$(node -p "require('../package.json').version")"
VERSION_CODE="${VERSION_CODE:-1}"
ICON="../src-tauri/icons/icon.png"

for tool in aapt2 d8 zipalign apksigner; do
  [ -x "$BUILD_TOOLS/$tool" ] || { echo "缺少 $BUILD_TOOLS/$tool" >&2; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺少 $PLATFORM" >&2; exit 1; }
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home)"
  export JAVA_HOME
fi
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null
fi

rm -rf build
mkdir -p build/res build/gen build/classes

# 启动图标：从桌面版图标按各密度缩放。
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  density="${pair%%:*}"
  size="${pair##*:}"
  mkdir -p "build/res/mipmap-$density"
  sips -z "$size" "$size" "$ICON" --out "build/res/mipmap-$density/ic_launcher.png" >/dev/null
done

"$BUILD_TOOLS/aapt2" compile --dir build/res -o build/res.zip
"$BUILD_TOOLS/aapt2" link -I "$PLATFORM" --manifest AndroidManifest.xml -A assets \
  --min-sdk-version 29 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java build/gen -o build/unsigned.apk build/res.zip

"$JAVA_HOME/bin/javac" --release 11 -encoding UTF-8 -Xlint:-options -classpath "$PLATFORM" -d build/classes \
  $(find src build/gen -name '*.java')
"$BUILD_TOOLS/d8" --release --min-api 29 --lib "$PLATFORM" --output build $(find build/classes -name '*.class')
(cd build && zip -q unsigned.apk classes.dex)

"$BUILD_TOOLS/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out build/roster-remote.apk build/aligned.apk
"$BUILD_TOOLS/apksigner" verify build/roster-remote.apk

echo "已生成 $(pwd)/build/roster-remote.apk（版本 ${VERSION_NAME}）"
