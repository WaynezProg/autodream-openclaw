# Design: Session Metadata Noise Pattern for Stale Cleaner

## Architecture

```
projects/autodream-openclaw/src/
├── dream-engine.ts          # 既有 stale-cleaner 流程
├── modules/stale-cleaner.ts # [MOD] 加入 noise pattern matching
└── config.ts                # [MOD] 加入 noisePatterns config type
```

## Stale Cleaner 改動

在 stale-cleaner 的掃描邏輯中，增加一個 **noise pattern 檢查階段**（在既有 staleness scoring 之前執行）。

```typescript
// --- stale-cleaner.ts ---

interface NoisePattern {
  regex: string;           // 正規表達式
  requires?: string;       // text 必須同時包含此字串（AND 條件）
  maxLength?: number;      // text 長度上限（超過則不視為 noise）
}

const DEFAULT_NOISE_PATTERNS: NoisePattern[] = [
  { regex: "^Session:\\s*\\d{4}-\\d{2}-\\d{2}", requires: "Session Key:" },
  { regex: "^Session ID:\\s*[0-9a-f-]{36}" },
  { regex: "reflection-event · agent:", maxLength: 200 },
];

function isNoiseMemory(text: string, patterns: NoisePattern[]): boolean {
  for (const p of patterns) {
    const re = new RegExp(p.regex);
    if (!re.test(text)) continue;
    if (p.requires && !text.includes(p.requires)) continue;
    if (p.maxLength && text.length > p.maxLength) continue;
    return true;
  }
  return false;
}

// 在掃描 loop 中：
for (const memory of allMemories) {
  if (isNoiseMemory(memory.text, noisePatterns)) {
    // dryRun → 計數；否則 → 刪除
    noiseCount++;
    if (!dryRun) await store.delete(memory.id);
    continue;
  }
  // ... 既有 staleness scoring 繼續 ...
}
```

## Config 擴充

```typescript
// config.ts
interface StaleCleanerConfig {
  // 既有欄位...
  noisePatterns?: NoisePattern[];  // 可選，覆蓋 DEFAULT_NOISE_PATTERNS
}
```

## Dream Report 擴充

在 dream report 中加入 `noiseDeleted` 欄位：

```jsonc
{
  "staleCleaner": {
    "scanned": 3630,
    "staleDeleted": 12,
    "noiseDeleted": 46,    // NEW
    "noisePatterns": 3     // 使用了幾條 pattern
  }
}
```

## Files to Modify

1. `projects/autodream-openclaw/src/modules/stale-cleaner.ts`
   - 加入 `NoisePattern` type 和 `isNoiseMemory()` function
   - 在掃描 loop 開頭加 noise 檢查
   - dream report 加入 `noiseDeleted` 計數

2. `projects/autodream-openclaw/src/config.ts`
   - `StaleCleanerConfig` 加 `noisePatterns?` 欄位

## Testing

1. `npm run build` 通過
2. 手動建一條 text 以 `Session: 2026-04-04` 開頭的 memory
3. `dream_now(dryRun: true)` → report 顯示 `noiseDeleted: 1`
4. `dream_now(dryRun: false)` → memory 被刪除
5. 正常 memory 不受影響
