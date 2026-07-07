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
pnpm typecheck    # TypeScript 类型检查
pnpm build        # 构建前端和后端
pnpm deploy:init  # 初始化 Docker 部署
```

启动服务只会初始化数据库结构，不会自动写入演示数据。演示职位和候选人是测试数据，只有执行 `pnpm demo:load` 时才会导入。

部署脚本在 `deploy/` 目录，包含 compose、nginx 配置、远程发布、离线镜像和备份。

## 功能视图

- 工作台概览：职位、简历、推荐人数与图表统计。
- 职位管理：新增、编辑、删除职位，JD 优化器和推荐面试问题。
- 简历甄选：按当前职位切换候选人，支持文本和多文件简历上传分析。
- 薪酬调研：检索 BOSS直聘与智联招聘公开搜索结果，从可解析薪资样本中计算 P25/P50/P75；若任一平台缺少有效样本，则返回“公开数据不足”。
