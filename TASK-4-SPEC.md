# Task 4: CLI 命令 + 文件

## 背景

Task 1-3 已完成：
- Plugin 骨架 + dream_now/dream_status tools
- 四個 analysis 模組
- 報告生成器
- 背景排程服務

Task 4 要實作 CLI 命令和使用文件。

## 現有 Code 結構

```
src/
├── index.ts                    ← Plugin entry
├── dream-engine.ts             ← runDream(), getLastRunResult()
├── dream-service.ts            ← 背景服務
├── lancedb-adapter.ts
├── analysis/
├── tools/
│   ├── dream-trigger.ts        ← dream_now tool
│   └── dream-status.ts         ← dream_status tool
└── report/
    └── reporter.ts
```

## 要做的事

### 1. CLI 命令 (`openclaw dream`)

使用 `api.registerCli()` 註冊 CLI 命令。

**SDK Type:**
```typescript
type OpenClawPluginCliContext = {
  program: Command;  // commander.js Command
  config: OpenClawConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};

api.registerCli((ctx) => {
  ctx.program
    .command("dream")
    .description("Run memory consolidation (autoDream)")
    .option("--scope <scope>", "Limit to specific scope")
    .option("--dry-run", "Run in dry-run mode (no changes)", true)
    .option("--no-dry-run", "Apply changes (merge duplicates, fix time)")
    .action(async (options) => {
      // 呼叫 runDream
    });
}, {
  descriptors: [
    { name: "dream", description: "Run memory consolidation", hasSubcommands: false }
  ]
});
```

**命令選項：**
- `--scope <scope>` — 限制特定 scope
- `--dry-run` — 只偵測不修改（預設）
- `--no-dry-run` — 實際執行修改

**輸出：**
- 印出 markdown 報告到 stdout
- exit code 0 = 成功，1 = 錯誤

### 2. README.md

```markdown
# autoDream — Memory Consolidation Plugin

自動整理記憶：偵測重複、矛盾、過時條目，轉換相對時間。

## 安裝

```bash
openclaw plugin install /path/to/autodream-openclaw
```

## 使用方式

### CLI 命令

```bash
# Dry-run（只看報告，不修改）
openclaw dream

# 限制特定 scope
openclaw dream --scope personal

# 實際執行修改
openclaw dream --no-dry-run
```

### Tools

- `dream_now` — 立即執行 dream（agent 可用）
- `dream_status` — 查詢上次執行結果

### 背景服務

每天凌晨 3 點自動執行（可透過 `scheduleHour` 調整）。

## 設定

在 `openclaw.yml` 中：

```yaml
plugins:
  entries:
    - location: /path/to/autodream-openclaw
      config:
        scheduleHour: 3
        minSessionsSinceLastRun: 3
        dedupThreshold: 0.90
        staleAgeDays: 60
        autoMergeDuplicates: false
        autoFixTime: false
        autoDeleteStale: false
```

### 設定選項

| 選項 | 類型 | 預設 | 說明 |
|------|------|------|------|
| `intervalHours` | number | 24 | 最小執行間隔（小時） |
| `scheduleHour` | number | 3 | 每日執行時間（0-23） |
| `minSessionsSinceLastRun` | number | 3 | 最少 session 數才觸發 |
| `notifyTarget` | string | - | Discord channel ID（可選） |
| `dedupThreshold` | number | 0.90 | 重複偵測閾值 |
| `maxChangesPerRun` | number | 20 | 每次最多修改數 |
| `staleAgeDays` | number | 60 | 過時天數閾值 |
| `autoMergeDuplicates` | boolean | false | 自動合併重複 |
| `autoFixTime` | boolean | false | 自動轉換相對時間 |
| `autoDeleteStale` | boolean | false | 自動刪除過時 |

## 部署計畫

### 第 1 週：Dry-Run
- 安裝 plugin，所有 auto 選項關閉
- 每天看報告，確認偵測準確度

### 第 2 週：Auto-Merge
- 開啟 `autoMergeDuplicates: true`
- 開啟 `autoFixTime: true`
- 矛盾和過時仍然只標記

### 第 3 週+：Full Auto
- 根據經驗決定是否開啟 `autoDeleteStale`
- 可調低 dedupThreshold（0.90 → 0.85）

## 分析模組

1. **重複偵測** — cosine similarity + keyword overlap
2. **時間正規化** — 相對時間 → 絕對時間
3. **矛盾偵測** — 啟用/停用、是/不是、key=value 衝突
4. **過時評分** — ageDays × importance

## 報告位置

```
~/.openclaw/memory/autodream-reports/
├── dream-2026-04-05T03-00-00-000Z.md
└── ...
```
```

### 3. 更新 index.ts

在 register() 中加入 registerCli 調用。

## 驗收標準

| 項目 | 標準 |
|------|------|
| `npx tsc` | 零 error |
| `npx vitest run` | 所有測試通過 |
| `openclaw dream --help` | 顯示命令說明 |
| `openclaw dream --dry-run` | 執行並印出報告 |
| README.md | 存在且完整 |

## 注意事項

- `ctx.program` 是 commander.js 的 Command 物件
- 命令要 return Promise<void>
- 錯誤時用 `console.error` 印出，process.exit(1)
- 所有 import 使用 `.js` 後綴
- 不要改 dream-engine.ts 的 signature
