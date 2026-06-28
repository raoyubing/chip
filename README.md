# 小松鼠(Recruitment Workbench)

一个本地离线优先的招聘工作台。当前版本已升级为 `pnpm` monorepo：前端使用 React + TypeScript + Vite，后端使用 Node.js + Fastify，并将数据写入本地 SQLite 文件。

## 项目结构

```text
zhaopin/
  apps/
    web/      # React + TypeScript + Vite 前端
    server/   # Node.js + Fastify + SQLite API
  legacy-static/ # 旧版纯静态页面备份
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
http://localhost:5174
```

## 常用命令

```bash
pnpm dev          # 同时启动前端和后端
pnpm dev:web      # 只启动前端
pnpm dev:server   # 只启动后端
pnpm typecheck    # TypeScript 类型检查
pnpm build        # 构建前端和后端
```

## 功能视图

- 工作台概览：职位、简历、推荐人数与图表统计。
- 职位管理：新增、编辑、删除职位，JD 优化器和推荐面试问题。
- 简历甄选：按当前职位切换候选人，支持文本和多文件简历上传分析。
- 薪酬调研：生成并缓存本地薪酬模拟数据。
