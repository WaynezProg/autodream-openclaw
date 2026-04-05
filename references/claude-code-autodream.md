# Claude Code autoDream 機制分析

> 來源：Claude Code v2.1.88 源碼洩漏（2026-03-31）

## 機制概述

autoDream 是 Claude Code 的記憶整理子系統，在使用者閒置或 session 結束時自動執行。

## 觸發條件

- 距上次整理 ≥ 24 小時 **且** ≥ 5 個新 session
- 使用者手動輸入 `dream`
- 以背景 sub-agent 執行，不阻擋主 session

## 四階段流程

### Phase 1: Orient
讀現有 MEMORY.md 索引，了解目前記憶狀態

### Phase 2: Gather
掃描近期 session transcript（.jsonl），找出未存的重要資訊：
- 偏好設定
- 使用者糾正
- 專案上下文

### Phase 3: Consolidate
- 建立新記憶條目
- 合併重複
- 修正矛盾
- 轉換相對時間（「上週四」→ 實際日期）

### Phase 4: Prune
- 清除過時條目
- 更新索引
- 保持 MEMORY.md < 200 行

## 關鍵設計

- MEMORY.md 上限 200 行（硬限制）
- 記憶被指示「不信任自己」——驗證真實檔案後才行動
- 整理 prompt 要求「synthesize into durable, well-organized memories」
- 監控 memory drift（記憶隨時間失真）

## 與 KAIROS 的關係

autoDream 是 KAIROS daemon 的子系統。KAIROS 是持續背景運行的 daemon，autoDream 是它的「睡眠整理」功能。KAIROS 還有：
- 15 秒 blocking budget（主動動作不超過 15 秒）
- append-only daily log
- PROACTIVE flag（主動推送）

## 來源

- Ars Technica 分析：arstechnica.com/ai/2026/04/
- dev.to 深度分析
- The New Stack 架構分析
- Reddit r/MCPservers、r/ClaudeAI 社群討論
