# Spec: Session Metadata Noise Pattern for Stale Cleaner

## Requirement: Identify Session Metadata Noise

autoDream 的 stale-cleaner SHALL 辨識以下 pattern 為 noise，自動標記並刪除。

### Pattern 1: Session Log Entries

```regex
^Session:\s*\d{4}-\d{2}-\d{2}
```

- GIVEN 一條 memory 的 text 以 `Session:` 開頭，後接日期格式
- AND text 包含 `Session Key:` 或 `Session ID:`
- THEN 標記為 noise，自動刪除

### Pattern 2: Session ID Only

```regex
^Session ID:\s*[0-9a-f-]{36}
```

- GIVEN 一條 memory 的 text 以 `Session ID:` 開頭，後接 UUID
- THEN 標記為 noise，自動刪除

### Pattern 3: Reflection Event Stubs

```regex
reflection-event · agent:
```

- GIVEN 一條 memory 的 text 包含 `reflection-event · agent:`
- AND text 長度 < 200 chars（排除正常的 reflection 內容）
- THEN 標記為 noise，自動刪除

## Requirement: Deletion Behavior

### Scenario: Normal autoDream run
- GIVEN autoDream 每日凌晨 3 點執行
- WHEN stale-cleaner 掃描所有 memories
- THEN 符合上述 pattern 的 entries 被刪除
- AND 刪除數量記錄在 dream report 中

### Scenario: DryRun mode
- GIVEN `dream_now(dryRun: true)`
- WHEN stale-cleaner 掃描
- THEN 只報告符合 pattern 的 entries 數量，不實際刪除

### Scenario: 正常 memory 不受影響
- GIVEN 一條 memory text 包含 "Session" 作為正常內容的一部分
- BUT text 不符合上述完整 pattern（例如 "I had a productive session today"）
- THEN 不被標記為 noise

## Requirement: Configurable Patterns

Pattern 清單 SHOULD 放在 autodream config 中，方便日後新增。

```jsonc
// autodream config
{
  "staleCleaner": {
    "noisePatterns": [
      { "regex": "^Session:\\s*\\d{4}-\\d{2}-\\d{2}", "requires": "Session Key:" },
      { "regex": "^Session ID:\\s*[0-9a-f-]{36}" },
      { "regex": "reflection-event · agent:", "maxLength": 200 }
    ]
  }
}
```

日後如果發現新的 noise pattern，只需加 config 不需改程式碼。
