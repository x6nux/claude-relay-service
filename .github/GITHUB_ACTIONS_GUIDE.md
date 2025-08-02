# GitHub Actions 工作流说明

本项目使用自动化的GitHub Actions工作流来管理版本发布和Docker镜像构建。

## 主工作流：`auto-release-pipeline.yml`

### 功能概述
这是项目的核心CI/CD工作流，负责自动化版本发布和所有组件的Docker镜像构建。

### 触发条件
- 推送到 `main` 分支时自动触发
- 跳过包含 `[skip ci]` 的提交
- 跳过由 GitHub Actions bot 创建的提交

### 主要功能
1. **版本管理**
   - 自动递增版本号（基于 VERSION 文件）
   - 生成更新日志（使用 git-cliff）
   - 创建 GitHub Release

2. **Docker镜像构建**
   - 构建主服务镜像
   - 构建中间层镜像（如果 middleware-go 目录存在）
   - 支持多架构（linux/amd64, linux/arm64）

3. **镜像标签策略**
   - 主服务: 
     - `latest` - 最新版本
     - `vX.Y.Z` - 带v前缀的版本号
     - `X.Y.Z` - 纯版本号
   - 中间层: 
     - `middleware-latest` - 最新版本
     - `middleware-vX.Y.Z` - 带v前缀的版本号
     - `middleware-X.Y.Z` - 纯版本号

4. **通知功能**
   - Telegram 通知（如配置）

## 使用指南

### 生产部署
使用版本标签确保稳定性：
```bash
# 使用特定版本（推荐）
docker pull lfreea/claude-relay-service:v1.2.6
docker pull lfreea/claude-relay-service:middleware-v1.2.6

# 使用最新版本
docker pull lfreea/claude-relay-service:latest
docker pull lfreea/claude-relay-service:middleware-latest
```

### 版本同步保证
通过集成构建流程，确保：
- 主服务和中间层始终使用相同版本号
- 版本发布时同时更新所有组件
- 避免组件间版本不一致

## 配置要求

### 必需的 GitHub Secrets
- `DOCKERHUB_USERNAME`: Docker Hub 用户名
- `DOCKERHUB_TOKEN`: Docker Hub 访问令牌

### 可选的 GitHub Secrets
- `TELEGRAM_BOT_TOKEN`: Telegram 机器人令牌
- `TELEGRAM_CHAT_ID`: Telegram 频道 ID

## 手动触发构建

如果需要手动触发构建，可以：
1. 创建一个空提交：`git commit --allow-empty -m "trigger build"`
2. 推送到main分支：`git push origin main`

## 跳过CI构建

如果某次提交不需要触发CI：
```bash
git commit -m "docs: update readme [skip ci]"
```