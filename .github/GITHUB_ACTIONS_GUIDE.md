# GitHub Actions 工作流说明

本项目使用两个主要的GitHub Actions工作流来管理Docker镜像的构建和发布。

## 工作流文件

### 1. `auto-release-pipeline.yml` - 自动发布流水线

**用途**: 生产环境的自动版本发布和Docker镜像构建

**触发条件**:
- 推送到 `main` 分支时自动触发
- 跳过包含 `[skip ci]` 的提交
- 跳过由 GitHub Actions bot 创建的提交

**主要功能**:
1. 自动递增版本号（基于 VERSION 文件）
2. 生成更新日志
3. 创建 GitHub Release
4. 构建并推送主服务 Docker 镜像
5. 构建并推送中间层 Docker 镜像（如果存在）
6. 发送 Telegram 通知（如配置）

**生成的镜像标签**:
- 主服务: `latest`, `vX.Y.Z`, `X.Y.Z`
- 中间层: `middleware-latest`, `middleware-vX.Y.Z`, `middleware-X.Y.Z`

### 2. `build-middleware-docker.yml` - 中间层开发构建

**用途**: 开发和测试环境的中间层镜像构建

**触发条件**:
- 推送到 `main`、`develop` 或 `feature/**` 分支
- 仅当 `middleware-go/` 目录有更改时（排除 .md 文件）
- Pull Request 到 `main` 分支
- 手动触发（workflow_dispatch）

**主要功能**:
1. 构建中间层 Docker 镜像用于测试
2. 生成分支特定的标签
3. 提供部署配置文件

**生成的镜像标签**:
- `{branch}-middleware`
- `{branch}-middleware-{sha}`
- PR: `pr-{number}-middleware`

## 使用建议

### 生产部署
使用 `auto-release-pipeline.yml` 生成的版本标签：
```bash
# 使用特定版本（推荐）
docker pull lfreea/claude-relay-service:v1.2.6
docker pull lfreea/claude-relay-service:middleware-v1.2.6

# 使用最新版本
docker pull lfreea/claude-relay-service:latest
docker pull lfreea/claude-relay-service:middleware-latest
```

### 开发测试
使用 `build-middleware-docker.yml` 生成的分支标签：
```bash
# 开发分支
docker pull lfreea/claude-relay-service:develop-middleware

# 功能分支
docker pull lfreea/claude-relay-service:feature-new-feature-middleware
```

## 版本同步

通过在 `auto-release-pipeline.yml` 中集成中间层构建，确保：
- 主服务和中间层使用相同的版本号
- 版本发布时同时更新两个组件
- 避免版本不一致的问题

## 配置要求

需要在 GitHub Secrets 中配置：
- `DOCKERHUB_USERNAME`: Docker Hub 用户名
- `DOCKERHUB_TOKEN`: Docker Hub 访问令牌
- `TELEGRAM_BOT_TOKEN`: Telegram 机器人令牌（可选）
- `TELEGRAM_CHAT_ID`: Telegram 频道 ID（可选）