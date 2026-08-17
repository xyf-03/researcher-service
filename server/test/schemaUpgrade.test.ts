import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'

function runUpgrade(dbPath: string): void {
  execFileSync(process.execPath, ['scripts/upgrade-schema.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  })
}

// 从「只有 base 表」的旧库跑全量增量脚本（幂等跑两遍）→ 三批表全到位 + T02 幂等列/索引
// + T03 生命周期时间戳列 + T06 产物三列 + user_version 归 6。
function assertUpgraded(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    // better-sqlite3 命名参数经对象绑定（$name）；表/索引名来自上方常量数组，无注入面。
    for (const table of ['text_trace_logs', 'figures', 'generation_jobs']) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=$name").get({ name: table }),
      ).toEqual({ name: table })
    }
    for (const index of [
      'text_trace_logs_traceId_key',
      'figures_ownerId_idx',
      // T02 幂等唯一索引（grilling §17）：并发重复创建去重的最终仲裁
      'figures_ownerId_idempotencyKey_key',
      'generation_jobs_figureId_key',
    ]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=$name").get({ name: index }),
      ).toEqual({ name: index })
    }
    // figures/generation_jobs 的持久化契约：queued 默认 + nullable errorMessage + T02 idempotencyKey 列
    const jobCols = db.prepare('PRAGMA table_info(generation_jobs)').all() as Array<{ name: string; dflt_value: string | null; notnull: number }>
    const status = jobCols.find((c) => c.name === 'status')!
    expect(status.dflt_value).toBe("'queued'")
    const errorMessage = jobCols.find((c) => c.name === 'errorMessage')!
    expect(errorMessage.notnull).toBe(0) // nullable
    // T03 执行生命周期时间戳：两列均 nullable（不迁移旧行、不给旧 queued 伪造时间）；跑增量的旧库
    // 由 ALTER TABLE ADD COLUMN 补齐，fresh 库建表已带。断言存在 + nullable 即验收 v5 增量到位。
    const startedAt = jobCols.find((c) => c.name === 'startedAt')!
    expect(startedAt.notnull).toBe(0) // nullable——queued 恒 null，仅原子领取后置位
    const finishedAt = jobCols.find((c) => c.name === 'finishedAt')!
    expect(finishedAt.notnull).toBe(0) // nullable——终态写入后置位
    const figureCols = db.prepare('PRAGMA table_info(figures)').all() as Array<{ name: string; notnull: number }>
    const idemKey = figureCols.find((c) => c.name === 'idempotencyKey')!
    expect(idemKey.notnull).toBe(0) // nullable——容 T02 前既有行（应用层恒非空）
    // T06 产物三列（grilling §6）：xml（文本）+ png（SQLite BLOB）+ evaluation（文本 JSON）。
    // 全 nullable——仅在 Job 提交 succeeded 终态时由 runner 原子写入，queued/running/failed 恒
    // null（不迁移旧行、不给旧 succeeded 伪造产物）。断言存在 + nullable 即验收 v6 增量到位。
    for (const col of ['xml', 'png', 'evaluation']) {
      const c = figureCols.find((x) => x.name === col)!
      expect(c.notnull).toBe(0)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(6)
  } finally {
    db.close()
  }
}

function makeBaseDb(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec(`
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
PRAGMA user_version=1;
`)
  } finally {
    db.close()
  }
}

describe('schema upgrade script', () => {
  it('adds text trace + AutoFigure tables to an existing base database and is idempotent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-upgrade-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    makeBaseDb(dbPath)

    runUpgrade(dbPath)
    runUpgrade(dbPath)

    assertUpgraded(dbPath)
  })

  it('upgrades an already-text-trace DB (v2) to AutoFigure tables + user_version=6', () => {
    const dir = mkdtempSync(path.join(tmpdir(), `schema-upgrade-${process.pid}-`))
    const dbPath = path.join(dir, 'panel.db')
    // 模拟上一轮增量已交付 text_trace_logs 的既有部署（v2）——增量脚本须只补 figures/generation_jobs。
    const db = new Database(dbPath)
    try {
      db.exec(`
CREATE TABLE "text_trace_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "containerName" TEXT,
    "sessionKey" TEXT,
    "runId" TEXT,
    "inputText" TEXT NOT NULL DEFAULT '',
    "outputText" TEXT NOT NULL DEFAULT '',
    "outputHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
PRAGMA user_version=2;
`)
    } finally {
      db.close()
    }

    runUpgrade(dbPath)
    runUpgrade(dbPath) // 幂等：第二遍不报错、不重复建表

    assertUpgraded(dbPath)
  })
})
