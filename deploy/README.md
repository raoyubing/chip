# 部署说明

部署目录借鉴 OA 项目的组织方式：`docker-compose.yml` 管运行服务，`scripts/` 放初始化、远程更新、离线镜像、备份和维护脚本。

## 首次部署

```bash
pnpm deploy:init
```

第一次执行会从 `deploy/.env.example` 生成 `deploy/.env` 并退出。检查配置后再执行一次：

```bash
pnpm deploy:init
```

脚本会在 Node 容器内执行依赖安装、构建前后端、下载 Whisper 模型，并启动 RustFS、kkFileView、后端和 nginx。
服务启动只初始化数据库结构，不会自动写入演示职位或候选人。

## 常用命令

```bash
pnpm deploy:up
pnpm deploy:down
pnpm deploy:restart
pnpm deploy:logs
pnpm deploy:ps
pnpm deploy:backup
pnpm deploy:reset-data -- --yes
pnpm deploy:ocr:build
pnpm deploy:ocr:load
pnpm deploy:ocr:up
pnpm deploy:ocr:down
pnpm deploy:ocr:logs
pnpm deploy:run 'pnpm --filter @xiaosongshu/server download:whisper-model'
pnpm deploy:run 'pnpm --filter @xiaosongshu/server demo:load -- --reset'
```

BOSS直聘薪酬抓取依赖 `boss-zhipin-scraper` 和本地已登录 Chrome CDP。普通 Docker 部署默认 `BOSS_SCRAPER_ENABLED=false`，会降级使用公开搜索结果；如要在服务器启用，需要先配置 Chrome、Python 依赖和登录态。

## PP-OCRv6

图片简历和扫描 PDF 的 OCR 由独立的 `xiaosongshu-ocr` 服务提供。它使用 `deploy/ocr/docker-compose.yml`，与主服务 Compose 分离，不会随主服务自动启动：

```bash
pnpm deploy:ocr:build
pnpm deploy:ocr:up
curl http://127.0.0.1:8019/health
```

构建命令同时将镜像导出到 `deploy/ocr/xiaosongshu-ppocrv6-3.7.0-amd64.tar`。换机后先加载镜像，再直接使用独立 Compose 启动：

```bash
pnpm deploy:ocr:load
docker compose --env-file deploy/ocr/.env -f deploy/ocr/docker-compose.yml up -d
```

模型目录必须包含：

```text
PP-OCRv6_medium_det/
PP-OCRv6_medium_rec/
```

启动脚本依次查找 `OCR_MODEL_HOST_DIR`、`apps/server/models/ppocrv6` 和 PaddleX 全局缓存目录，并以只读方式挂载到容器 `/models`。模型不复制到项目、不写入镜像，也不会由容器隐式下载。若模型已在其他位置，直接在 `deploy/ocr/.env` 中指定即可：

```bash
OCR_MODEL_HOST_DIR=/path/to/official_models
```

Apple Silicon 上默认通过 `linux/amd64` 运行，因为 PaddlePaddle 3.3.1 没有 Linux arm64 wheel；Linux x86_64 服务器可直接使用同一配置。主服务容器通过宿主机 `8019` 端口调用，本地开发默认通过 `http://127.0.0.1:8019` 调用。OCR 服务未启动时，普通文本型简历解析不受影响，但图片和扫描 PDF 不会产生 OCR 文本。

## 远程发布

复制 `ci/example.json` 为 `ci/dev.json`，填好服务器地址、部署目录和分支后执行：

```bash
pnpm deploy:remote dev
```

远程服务器会 `git pull --ff-only`，然后在部署目录内用 compose 的 Node 容器完成安装、构建、模型下载和服务重启。

## 离线镜像

将 compose 需要的镜像 tar 放到 `deploy/images/`，再执行：

```bash
pnpm deploy:pack-images
pnpm deploy:load-images
```

镜像文件名可以按 `deploy/image-map.tsv` 映射。
