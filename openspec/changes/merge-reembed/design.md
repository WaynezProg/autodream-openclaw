# Design: Re-embed After Merge

## Architecture

```
dream-engine.ts
  └── mergeDuplicates() / updateMemoryText()
        ├── update text in LanceDB
        ├── [NEW] call embedder.embed(newText)
        └── [NEW] update vector in LanceDB row
```

## Key Decisions

### 1. Embedder Initialization

autoDream 需要自己的 embedder instance。方案：

- **選定方案**：從 `autodream.config` 讀取 `embeddingModel`（預設 `text-embedding-3-small`），用 OpenAI API 建立 embedder
- 原因：autodream 是獨立 plugin，不依賴 lancedb-pro 的內部 embedder

### 2. LanceDB Update Strategy

LanceDB 的 `update()` 支援 `where` + `values`，可以同時更新 text 和 vector：

```typescript
await table.update({
  where: `id = '${memoryId}'`,
  values: { text: newText, vector: newVector }
});
```

如果 LanceDB 的 update 不支援 vector 欄位，改用 delete + insert。

### 3. Batch vs Single

- 每條 merge 獨立 re-embed（不 batch），因為 merge 數量通常 < 50/run
- text-embedding-3-small 的 rate limit 足夠（3000 RPM）

### 4. Error Handling

```typescript
try {
  const newVector = await embedder.embed(mergedText);
  await table.update({ where: `id = '${id}'`, values: { text: mergedText, vector: newVector } });
} catch (err) {
  logger.warn(`[autodream] re-embed failed for ${id}: ${err.message}`);
  // Still update text without vector
  await table.update({ where: `id = '${id}'`, values: { text: mergedText } });
}
```

## Files to Modify

1. `src/dream-engine.ts` — 加入 embedder 參數，merge 後 re-embed
2. `src/index.ts` — 初始化 embedder，傳入 dream-engine
3. `package.json` — 如需 openai SDK（可能已有）

## Testing

- 手動跑 `dream_now(dryRun: false)` 觀察 log 是否出現 re-embed 成功訊息
- 檢查合併後的記憶 vector 是否與新 text 相符（用 `memory_recall` 搜新 text）
