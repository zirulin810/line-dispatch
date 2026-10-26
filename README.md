# LINE 派工（line-dispatch）

用 LINE 傳一句話，就能修改網站。

不會寫程式的人（例如店家員工）只要私訊 LINE bot 說「要改網站哪裡」，Claude 就會改好網站，並把預覽網址傳回 LINE。
確認沒問題後按［上線］，修改才會正式發佈。

![LINE 派工架構圖](docs/architecture.png)

## 運作流程

1. 使用者私訊 LINE bot，例如「營業時間改成週日公休」
2. Cloudflare Worker 驗證 LINE 簽章後，在網站 repo 開一個 GitHub issue
3. issue 觸發網站 repo 的 GitHub Actions，由 Claude Code 修改網站、推分支、開 PR
4. Cloudflare Pages 部署預覽站，workflow 在 issue 留言回報
5. Worker 收到 GitHub webhook，把摘要、預覽連結和［上線］［取消這件］按鈕推給提出者
6. 提出者按［上線］，Worker 合併 PR，網站正式更新，並通知管理者

還想再改就直接回覆，會接著修改同一件；不要了就按［取消這件］。

## 特色

- **好友審核**：新好友要等管理者在 LINE 上按鈕開放才能使用
- **只有提出者能上線**：別人（包括管理者）不能替他按［上線］
- **簽章驗證**：LINE 和 GitHub 的 webhook 都會驗 HMAC 簽章
- **漏接補救**：每 5 分鐘排程對帳，GitHub webhook 漏送時直接讀 issue 留言補發通知
- **不用架伺服器**：閘道跑在 Cloudflare Worker，改網站跑在 GitHub Actions

## 技術

| 部分 | 使用 |
| --- | --- |
| 閘道 | Cloudflare Workers（JavaScript，用 Wrangler 部署） |
| 狀態儲存 | Cloudflare KV |
| 訊息 | LINE Messaging API（Webhook、Reply／Push API、Postback 按鈕） |
| 修改網站 | GitHub Actions + Claude Code（workflow 裝在網站 repo） |
| 預覽 | Cloudflare Pages |
| 測試 | Node.js 內建 test runner（`npm test`） |

## 技術文件

資料流、各種情況的處理方式、部署步驟與開發說明，見 [docs/技術說明.md](docs/技術說明.md)。
