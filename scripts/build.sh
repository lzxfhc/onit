#!/bin/bash

# Onit 构建脚本：打包 .app + 创建包含安装脚本的 .dmg

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== Onit Build Script ==="
echo ""

# Step 1: Build frontend + electron
echo "→ Step 1: Building frontend and electron..."
npx vite build

# Step 2: Build .app with electron-builder (dir target only, skip dmg)
echo ""
echo "→ Step 2: Packaging Onit.app..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir

# Step 3: Create custom DMG with install script
echo ""
echo "→ Step 3: Creating DMG with install script..."

DMG_NAME="Onit-1.0.0-arm64.dmg"
DMG_PATH="$PROJECT_DIR/dist/$DMG_NAME"
STAGING_DIR="$PROJECT_DIR/dist/dmg-staging"

# Clean up
rm -rf "$STAGING_DIR"
rm -f "$DMG_PATH"

# Create staging directory
mkdir -p "$STAGING_DIR"

# Copy .app
cp -R "$PROJECT_DIR/dist/mac-arm64/Onit.app" "$STAGING_DIR/"

# Copy install script
cp "$PROJECT_DIR/scripts/install-onit.command" "$STAGING_DIR/安装 Onit.command"
chmod +x "$STAGING_DIR/安装 Onit.command"

# Create Applications symlink
ln -s /Applications "$STAGING_DIR/Applications"

# Create DMG
hdiutil create -volname "Onit" \
  -srcfolder "$STAGING_DIR" \
  -ov -format UDZO \
  "$DMG_PATH"

# Clean up staging
rm -rf "$STAGING_DIR"

echo ""
echo "=== Build Complete ==="
echo "  App: dist/mac-arm64/Onit.app"
echo "  DMG: dist/$DMG_NAME"
echo ""
