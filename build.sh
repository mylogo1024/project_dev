#!/bin/bash

# 快速打包脚本

echo "📦 开始打包日常开发工具箱..."
echo ""

# 清理旧的构建产物
echo "🧹 清理旧文件..."
rm -rf dist
rm -rf dist-app

# 构建前端
echo ""
echo "🔨 构建前端..."
npm run build

# 打包应用
echo ""
echo "📦 打包应用..."
npm run build:electron

echo ""
echo "✅ 打包完成！"
echo ""
echo "📂 打包产物位置: dist-app/"
ls -lh dist-app/
