# Workspace

main agent 的工作区（openclaw.json `agents.list[0].workspace = ~/.openclaw/workspace`）。agent 在此读写研究产物；面板将提供统一文件 CRUD 接口供运维浏览 / 维护（issue #586，规划中）。

由派生镜像骨架初始化（named volume 首挂自动填充，ADR 0011）。
