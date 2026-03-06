#!/bin/bash

# Onit 安装脚本
# 右键点击此文件 → 打开，即可自动安装 Onit

APP_NAME="Onit.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_APP="$SCRIPT_DIR/$APP_NAME"
DEST_DIR="/Applications"
DEST_APP="$DEST_DIR/$APP_NAME"

clear
echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║                                       ║"
echo "  ║       Onit - 安装程序                  ║"
echo "  ║       You say it. Onit.               ║"
echo "  ║                                       ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# 检查源 app 是否存在
if [ ! -d "$SOURCE_APP" ]; then
    echo "  ❌ 未找到 $APP_NAME"
    echo "  请确保此脚本与 $APP_NAME 在同一目录中。"
    echo ""
    read -p "  按回车键退出..." dummy
    exit 1
fi

# 如果已安装，先关闭并移除旧版本
if [ -d "$DEST_APP" ]; then
    echo "  → 检测到已安装的旧版本，正在替换..."
    osascript -e 'quit app "Onit"' 2>/dev/null
    sleep 1
    rm -rf "$DEST_APP"
fi

# 复制到 Applications
echo "  → 正在安装到 /Applications..."
cp -R "$SOURCE_APP" "$DEST_DIR/"

if [ $? -ne 0 ]; then
    echo ""
    echo "  ❌ 安装失败，尝试使用管理员权限..."
    sudo cp -R "$SOURCE_APP" "$DEST_DIR/"
    if [ $? -ne 0 ]; then
        echo "  ❌ 安装失败，请手动将 $APP_NAME 拖入 Applications 文件夹。"
        echo ""
        read -p "  按回车键退出..." dummy
        exit 1
    fi
fi

# 移除隔离属性（解决"文件已损坏"问题）
echo "  → 正在移除安全隔离标记..."
xattr -cr "$DEST_APP" 2>/dev/null
if [ $? -ne 0 ]; then
    sudo xattr -cr "$DEST_APP" 2>/dev/null
fi

echo "  → 正在启动 Onit..."
echo ""
echo "  ✅ 安装完成！"
echo ""

# 启动应用
open "$DEST_APP"

# 3 秒后自动关闭终端窗口
sleep 3
osascript -e 'tell application "Terminal" to close front window' 2>/dev/null &
exit 0
