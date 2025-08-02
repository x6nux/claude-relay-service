#!/bin/bash

# Go中间层Docker构建和发布脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐳 Claude Middleware Docker Build Script${NC}"
echo "=============================================="

# 检查当前目录
if [ ! -d "middleware-go" ]; then
    echo -e "${RED}❌ Error: middleware-go directory not found${NC}"
    echo "Please run this script from the project root directory"
    exit 1
fi

# 检查是否有未提交的更改
if ! git diff --quiet HEAD -- middleware-go/; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes in middleware-go/${NC}"
    echo "Files with changes:"
    git diff --name-only HEAD -- middleware-go/
    echo ""
    read -p "Do you want to continue anyway? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}❌ Build cancelled${NC}"
        exit 1
    fi
fi

# 获取当前分支
BRANCH=$(git branch --show-current)
echo -e "${BLUE}📍 Current branch: ${BRANCH}${NC}"

# 检查分支
if [ "$BRANCH" != "main" ]; then
    echo -e "${YELLOW}⚠️  You are not on the main branch${NC}"
    echo "GitHub Action will build for branch: $BRANCH"
    echo "Docker tag will be: ${BRANCH}-middleware"
    echo ""
    read -p "Continue with current branch? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}❌ Build cancelled${NC}"
        exit 1
    fi
fi

# 选择构建方式
echo ""
echo "Choose build method:"
echo "1) Commit and push to trigger GitHub Action (推荐)"
echo "2) Local Docker build for testing"
echo "3) Show build status and logs"
echo ""
read -p "Enter your choice (1-3): " -n 1 -r
echo ""

case $REPLY in
    1)
        echo -e "${GREEN}🚀 Triggering GitHub Action build...${NC}"
        
        # 检查是否有变更需要提交
        if git diff --quiet HEAD -- middleware-go/; then
            echo -e "${YELLOW}📝 No changes to commit, creating a build trigger...${NC}"
            echo "# Build trigger $(date)" >> middleware-go/.build-trigger
            git add middleware-go/.build-trigger
            git commit -m "build: trigger middleware Docker build

[middleware] Trigger Docker build for Go middleware layer"
        else
            echo -e "${YELLOW}📝 Committing middleware changes...${NC}"
            git add middleware-go/
            git commit -m "feat(middleware): update Go middleware layer

[middleware] Updated Go middleware with latest changes"
        fi
        
        echo -e "${GREEN}📤 Pushing to GitHub...${NC}"
        git push origin $BRANCH
        
        echo ""
        echo -e "${GREEN}✅ Build triggered successfully!${NC}"
        echo -e "${BLUE}🔗 Check build status at:${NC}"
        echo "   https://github.com/$(git config --get remote.origin.url | sed 's/.*[:/]\([^/]*\)\/\([^.]*\).*/\1\/\2/')/actions"
        ;;
        
    2)
        echo -e "${GREEN}🔨 Building Docker image locally...${NC}"
        
        cd middleware-go
        
        # 构建镜像
        COMMIT_SHA=$(git rev-parse --short HEAD)
        IMAGE_TAG="claude-relay-service:middleware-local-${COMMIT_SHA}"
        
        echo -e "${BLUE}📦 Building: ${IMAGE_TAG}${NC}"
        docker build -t "$IMAGE_TAG" .
        
        echo ""
        echo -e "${GREEN}✅ Local build completed!${NC}"
        echo -e "${BLUE}🏃 To run the image:${NC}"
        echo "   docker run -p 8080:8080 -e TARGET_URL=http://localhost:3001 -e REDIS_HOST=localhost $IMAGE_TAG"
        echo ""
        echo -e "${BLUE}🧪 To test the image:${NC}"
        echo "   curl http://localhost:8080/health"
        ;;
        
    3)
        echo -e "${GREEN}📊 Checking build status...${NC}"
        
        # 获取仓库信息
        REPO_URL=$(git config --get remote.origin.url)
        if [[ $REPO_URL == *"github.com"* ]]; then
            REPO_PATH=$(echo $REPO_URL | sed 's/.*[:/]\([^/]*\)\/\([^.]*\).*/\1\/\2/')
            echo -e "${BLUE}🔗 Repository: https://github.com/${REPO_PATH}${NC}"
            echo -e "${BLUE}🔗 Actions: https://github.com/${REPO_PATH}/actions${NC}"
            echo -e "${BLUE}🔗 Packages: https://github.com/${REPO_PATH}/pkgs/container/claude-relay-service${NC}"
        fi
        
        # 显示最近的提交
        echo ""
        echo -e "${BLUE}📝 Recent middleware commits:${NC}"
        git log --oneline -5 --grep="middleware" --grep="build" --grep="docker"
        ;;
        
    *)
        echo -e "${RED}❌ Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}🎉 Script completed!${NC}"