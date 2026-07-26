# 小松鼠(Recruitment Workbench)

一个本地离线优先的招聘工作台。当前版本已升级为 `pnpm` monorepo：前端使用 React + TypeScript + Vite，后端使用 Node.js + Fastify，并将数据写入本地 SQLite 文件。

## 项目结构

```text
zhaopin/
  apps/
    web/      # React + TypeScript + Vite 前端
    server/   # Node.js + Fastify + SQLite API
  package.json
  pnpm-workspace.yaml
```

## 数据位置

SQLite 数据库文件会生成在：

```text
apps/server/data/xiaosongshu.sqlite
```

简历上传的原始文件会以 BLOB 形式写入 SQLite，因此换浏览器不丢数据；只要保留这个数据库文件即可迁移。

## 启动方式

```bash
cd zhaopin
pnpm install
pnpm dev
```

然后访问：

```text
http://localhost:5173
```

后端 API 默认运行在：

```text
http://localhost:5175
```

## 常用命令

```bash
pnpm dev          # 同时启动前端和后端
pnpm dev:web      # 只启动前端
pnpm dev:server   # 只启动后端
pnpm demo:load    # 按需加载演示数据；加 -- --reset 会先清空现有 SQLite 数据
pnpm download:whisper-model # 下载本地语音转写模型到 apps/server/models
pnpm download:boss-scraper  # 下载 boss-zhipin-scraper 并安装 Python 依赖到 apps/server/.venv
pnpm boss-scraper:setup-chrome # 启动 BOSS 专用 Chrome 并登录
pnpm boss-scraper:check # 检查 BOSS CDP、依赖和登录态
pnpm deploy:ocr:build # 构建 PP-OCRv6 镜像并导出到 deploy/ocr
pnpm deploy:ocr:up # 单独启动 PP-OCRv6 服务
pnpm deploy:ocr:down # 停止 PP-OCRv6 服务
pnpm typecheck    # TypeScript 类型检查
pnpm build        # 构建前端和后端
pnpm deploy:init  # 初始化 Docker 部署
```

启动服务只会初始化数据库结构，不会自动写入演示数据。演示职位和候选人是测试数据，只有执行 `pnpm demo:load` 时才会导入。

图片简历和扫描 PDF 使用独立的 PP-OCRv6 medium 服务识别。Node 后端通过 HTTP 调用该服务，普通 PDF、DOC 和 DOCX 仍优先读取文本层。OCR 服务不会随 `pnpm deploy:up` 启动，独立配置位于 `deploy/ocr/docker-compose.yml`：

```bash
pnpm deploy:ocr:build
pnpm deploy:ocr:up
```

`deploy:ocr:build` 会把镜像导出为 `deploy/ocr/xiaosongshu-ppocrv6-3.7.0-amd64.tar`。启动脚本会复用 `${PADDLEX_HOME:-~/.paddlex}/official_models` 下已有的 `PP-OCRv6_medium_det` 和 `PP-OCRv6_medium_rec`；也可通过 `deploy/ocr/.env` 的 `OCR_MODEL_HOST_DIR` 指定其他目录。模型只读挂载到容器，不会被复制、打入镜像或重新下载。本地 Node 默认调用 `http://127.0.0.1:8019`。

部署脚本在 `deploy/` 目录，包含 compose、nginx 配置、远程发布、离线镜像和备份。

## 功能视图

- 工作台概览：职位、简历、推荐人数与图表统计。
- 职位管理：新增、编辑、删除职位，JD 优化器和推荐面试问题。
- 简历甄选：按当前职位切换候选人，支持文本和多文件简历上传分析。
- 薪酬调研：通过 `eatmoreduck/boss-zhipin-scraper` 连接本地已登录 Chrome CDP 获取 BOSS 直聘明文薪资样本，并从有效样本中计算 P25/P50/P75。
