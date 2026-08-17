# OpenClaw Wiki

本目录是面板托管 OpenClaw 容器的 memory-wiki vault（memory-wiki 插件，`vaultMode=isolated`，渲染 `obsidian`）。

- vault 路径：`~/.openclaw/wiki/main`
- 渲染模式：obsidian（wikilinks + frontmatter）
- 搜索语料：wiki（`memory.search.backend=shared, corpus=wiki`）
- 机器读经 memory-wiki 插件（`wiki_apply` / `wiki get`）；面板将提供统一文件 CRUD 接口供运维读写（issue #586，规划中）。

由派生镜像骨架初始化（named volume 首挂自动填充，ADR 0011）。
