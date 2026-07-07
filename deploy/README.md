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
pnpm deploy:run 'pnpm --filter @xiaosongshu/server download:whisper-model'
pnpm deploy:run 'pnpm --filter @xiaosongshu/server demo:load -- --reset'
```

BOSS直聘薪酬抓取依赖 `boss-zhipin-scraper` 和本地已登录 Chrome CDP。普通 Docker 部署默认 `BOSS_SCRAPER_ENABLED=false`，会降级使用公开搜索结果；如要在服务器启用，需要先配置 Chrome、Python 依赖和登录态。

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
