# Hermes Agent 自動 Skill 生成機制分析

> 來源：Hermes Agent 官方文件 + 社群分析（2026-03）

## 機制概述

Hermes Agent 的 `skill_manage` tool 讓 agent 在完成複雜任務後，自動將解法存成可重用的 skill document。

## 觸發條件

Agent 在以下情境會建立 skill：
1. 成功完成複雜任務（5+ tool calls）
2. 遇到錯誤並找到解法
3. 使用者糾正了做法
4. 發現非顯而易見的 workflow

## Skill 生成 Actions

- **create** — 建立新 skill
- **update** — 更新既有 skill（加入新經驗）
- **delete** — 移除過時 skill

## Token 效率設計

三層載入，按需取用：
```
Level 0: skills_list()           → [{name, description, category}]  (~3k tokens)
Level 1: skill_view(name)        → 完整 skill 內容
Level 2: skill_view(name, path)  → 特定參考檔案
```

## Skill 格式（SKILL.md）

遵循 agentskills.io 開放標準，支援：
- platforms 欄位（macos / linux / windows 限制）
- references/ 子目錄放參考資料
- scripts/ 子目錄放自動化腳本

## 學習迴路

```
Execute → Evaluate → Extract → Refine → Retrieve
```

社群回報：第一週後效率提升 ~40%（重複任務場景）

## Multi-Agent Skill Sharing

- Coordinator agent 根據 skill 相關性路由任務
- 跨 agent skill 共享（有控制）
- 一個 agent 的經驗可以幫到相關領域的其他 agent

## 與 OpenClaw 的對應

| Hermes | OpenClaw 現有 |
|--------|--------------|
| skill_manage | self_improvement_extract_skill（memory-lancedb-pro） |
| 自動觸發 | 無（手動） |
| skills_list() 三層載入 | Skill 描述 → SKILL.md → references/（類似） |
| agentskills.io 格式 | ClawHub 格式 |

## 結論

Hermes 的核心優勢是「自動」——agent 自己判斷是否要建立 skill。
OpenClaw 已有類似的工具基礎（self_improvement_*），缺的是自動觸發邏輯。
我們的方案：不做全自動，做「自動建議 + 人工確認」。
