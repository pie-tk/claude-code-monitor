#!/usr/bin/env bash
# build-mac.sh — macOS universal DMG 打包脚本（Task 11）
#
# 产出：bin/cc-console-<ver>-universal.dmg
#   - universal（arm64 + amd64 via lipo）
#   - .app bundle（含 cc-console / cc-console-sl / bridge.mjs / icons.icns / Info.plist）
#   - ad-hoc 签名（codesign --force --deep --sign -）
#   - hdiutil UDZO 压缩 DMG
#
# 已知限制：trayicon.png 源为 32x32 低分辨率，icns 循环基于先放大到 1024x1024 的
# 源图切尺寸，图标模糊（功能不受影响），留待用户提供高清源优化。
set -euo pipefail
cd "$(dirname "$0")"

# 确保 Go SDK 可用（CI 环境可能未预置到 PATH）
if ! command -v go >/dev/null 2>&1; then
  if [ -x "$HOME/go-sdk/go/bin/go" ]; then
    export GOROOT="$HOME/go-sdk/go"
    export PATH="$GOROOT/bin:$PATH"
  fi
fi
export GOPROXY="${GOPROXY:-https://goproxy.cn}"
export GOSUMDB="${GOSUMDB:-off}"

VER=$(grep -m1 'const Version' service/monitor_service.go | sed 's/.*"\(.*\)".*/\1/')
[ -n "$VER" ] || { echo "无法解析版本号"; exit 1; }
APP_NAME="cc-console"
APP="bin/${APP_NAME}.app"
DMG="bin/${APP_NAME}-${VER}-universal.dmg"
STAGE="bin/stage"

echo "==> [1/6] 前端构建（npm ci 宽容回退）"
( cd frontend
  # package-lock.json 可能含 npmmirror resolved 变更导致 npm ci 严格校验失败，
  # 改用 npm install（node_modules 已存在则快速幂等）。目标：dist 更新。
  npm ci || npm install
  npm run build
)

echo "==> [2/6] 生成 icons.icns（源图先规整到 1024x1024）"
# 先清理上次中间产物（arm64/amd64 二进制 + iconset），避免部分失败运行后残留陈旧 lipo 输入。
rm -rf "$STAGE"
mkdir -p "$STAGE/icon.iconset"
# trayicon.png 仅 32x32，直接放大到 1024 会有模糊，但能保证 iconutil 接受正方形源。
sips -z 1024 1024 trayicon.png --out "$STAGE/icon-src.png" >/dev/null
SRC="$STAGE/icon-src.png"
for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
  set -- $spec; sz=$1; name=$2
  sips -z $sz $sz "$SRC" --out "$STAGE/icon.iconset/icon_${name}.png" >/dev/null
done
iconutil -c icns "$STAGE/icon.iconset" -o "$STAGE/icons.icns"

echo "==> [3/6] universal 二进制（arm64 + amd64 lipo）"
mkdir -p bin
LDFLAGS="-s -w"
# 两个架构都显式启用 CGO 并指定 cgo target，使脚本 host-agnostic：
# Wails v3 的 pkg/mac 是 cgo（Objective-C），
#   - 在 Apple Silicon 上 GOARCH=amd64 会令 go 默认 CGO_ENABLED=0 → cgo 文件被排除 → 编译失败；
#   - 在 Intel（x86_64）host 上跑 GOARCH=arm64 时，cgo（ObjC）若交由 host 默认 clang 会编成 amd64，
#     与 Go 的 arm64 代码架构不匹配 → 链接失败。
# 显式指定 clang -target（arm64-apple-darwin / x86_64-apple-darwin）后，无论 host 是
# Apple Silicon 还是 Intel Mac，另一架构都能用系统 SDK 正确交叉编译。
# 前提：装了 Xcode/CLT 的 clang。
#
# 固定 macOS deployment target = 11.0（Big Sur）：
#   - 兑现 build/darwin/Info.plist 的 LSMinimumSystemVersion=11.0 声明，避免 Wails pkg/mac 的
#     ObjC 对象按本机 SDK（15.x）编译、在 11.0-14.x 上因弱链接触发未定义符号崩溃；
#   - 消除 ld "building for newer macOS version ... than being linked (11.0)" 告警。
# 关键：-mmacosx-version-min 取的是 macOS 产品版本（11.0 = Big Sur）；-target triple 保持无版本，
#   因为 triple 里的数字是 Darwin 内核版本（darwin11 = macOS 10.7 Lion），若写成
#   -target arm64-apple-darwin11.0 会错误指向 macOS 10.7，arm64 构建会失败
#   （arm64 macOS 起步于 11.0 = darwin20）。
export MACOSX_DEPLOYMENT_TARGET=11.0
export CGO_ENABLED=1
ARM64_CC="clang -target arm64-apple-darwin -mmacosx-version-min=11.0"
AMD64_CC="clang -target x86_64-apple-darwin -mmacosx-version-min=11.0"
# 主程序
CGO_ENABLED=1 GOARCH=arm64 CC="$ARM64_CC" go build -ldflags="$LDFLAGS" -o "$STAGE/cc-console-arm64" .
CGO_ENABLED=1 GOARCH=amd64 CC="$AMD64_CC" go build -ldflags="$LDFLAGS" -o "$STAGE/cc-console-amd64" .
lipo -create -output "$STAGE/cc-console" "$STAGE/cc-console-arm64" "$STAGE/cc-console-amd64"
# slhook 桥接二进制
CGO_ENABLED=1 GOARCH=arm64 CC="$ARM64_CC" go build -ldflags="$LDFLAGS" -o "$STAGE/cc-console-sl-arm64" ./cmd/slhook
CGO_ENABLED=1 GOARCH=amd64 CC="$AMD64_CC" go build -ldflags="$LDFLAGS" -o "$STAGE/cc-console-sl-amd64" ./cmd/slhook
lipo -create -output "$STAGE/cc-console-sl" "$STAGE/cc-console-sl-arm64" "$STAGE/cc-console-sl-amd64"

echo "==> [4/6] 构造 .app bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$STAGE/cc-console"      "$APP/Contents/MacOS/cc-console"
cp "$STAGE/cc-console-sl"   "$APP/Contents/Resources/cc-console-sl"
cp cmd/slhook/bridge.mjs    "$APP/Contents/Resources/bridge.mjs"
cp "$STAGE/icons.icns"      "$APP/Contents/Resources/icons.icns"
sed "s/{{VERSION}}/$VER/g" build/darwin/Info.plist > "$APP/Contents/Info.plist"

echo "==> [5/6] ad-hoc 签名"
codesign --force --deep --sign - "$APP"

echo "==> [6/6] 打 DMG"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$APP" -ov -format UDZO "$DMG"

echo "完成：$DMG"
echo "--- lipo -info ---"
lipo -info "$APP/Contents/MacOS/cc-console"
echo "--- codesign verify ---"
codesign --verify --deep --strict "$APP" && echo "codesign: OK"
