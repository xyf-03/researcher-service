# Wiki 维护守则（供 agent）

- 本 vault 由 memory-wiki 插件管理（`vaultMode=isolated`、渲染 `obsidian`、搜索语料 `wiki`）。
- 内容页放五核心目录：`concepts/` `entities/` `sources/` `syntheses/` `reports/`；新想法先丢 `inbox.md`。
- 机器读经插件 CLI（`openclaw wiki ...`）；生成块（generated blocks，如 `index.md` 的 `openclaw:wiki:index`）归插件所有，勿手改。
- `WIKI.md` / `index.md` / `inbox.md` 为受管理文件（面板统一文件 CRUD 接口对其有保留语义）。
