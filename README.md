# LINE 派工閘道（line-dispatch）

店裡的人在 LINE 傳「要改網站哪裡」→ 這個 Cloudflare Worker 開成 GitHub issue → 範例網站 repo 的
`line-request` workflow 讓 Claude 改好、開 PR → Cloudflare Pages 出預覽 → Worker 把預覽推到 LINE →
網站負責人按［上線］才合併。

```
LINE ──訊息──▶ /line/webhook ──開 issue／留言──▶ GitHub（my-site.github.io）
                                                   │ workflow：Claude 改 → 推 line/<issue> → 開 PR
                                                   │ Cloudflare Pages：部署分支預覽
GitHub ──事件──▶ /github/webhook ──改好了＋預覽連結──▶ LINE（發訊息的人、負責人）
負責人按［上線］／［退回］──▶ /line/webhook ──合併／關閉 PR──▶ GitHub
```

## 行為

| 情況 | Worker 做什麼 |
| --- | --- |
| 白名單的人傳文字 | 開帶 `line-request` 標籤的 issue，回「收到，處理中（#編號）」 |
| 同一人還有未結案的件 | 改成留言到那個 issue（追加修改），回「收到，接著改」 |
| 非白名單的人傳訊息 | 不理，只在紀錄裡留下 userId |
| workflow 回報改好（它會等 Pages 預覽部署好才回報） | 推給負責人（摘要＋預覽＋［看預覽］［上線］［退回］），也推給發訊息的人（摘要＋預覽） |
| workflow 反問／沒有要改的／失敗 | 把內容推給發訊息的人；失敗時也通知負責人 |
| 負責人按［上線］ | squash 合併 PR、刪分支，通知雙方；issue 由 PR 的 `Closes #` 自動關閉 |
| 負責人按［退回］ | 關 PR、關 issue、刪分支，通知發訊息的人 |
| 其他人按按鈕、或按到舊一輪的按鈕 | 拒絕，不合併 |
| 在 GitHub 上直接合併／關閉 | 同步狀態；合併時通知發訊息的人 |

GitHub 的 webhook 偶爾會漏送：一輪開始超過 5 分鐘還沒收到 workflow 的回報，每 5 分鐘一次的排程
會直接去 GitHub 讀 issue 留言，照回報補做。

## 檔案

| 路徑 | 內容 |
| --- | --- |
| `src/index.js` | 路由、LINE 與 GitHub 事件處理、排程 |
| `src/crypto.js` | LINE／GitHub 簽章驗證 |
| `src/clients.js` | LINE Messaging API、GitHub REST API 的呼叫 |
| `src/store.js` | KV 裡的件狀態 |
| `src/messages.js` | 所有送到 LINE 的文字（改口吻只改這份） |
| `test/` | 自動測試（`npm test`） |
| `wrangler.toml` | Worker 設定；憑證不在這裡，一律用 `wrangler secret` |

## 部署

以下指令都在這個資料夾裡執行（Windows 用 PowerShell 即可）。需要 Node.js 18 以上。

### 1. 安裝與登入 Cloudflare

```powershell
npm install
npx wrangler login          # 會開瀏覽器授權 Cloudflare 帳號
```

### 2. 建立 KV

```powershell
npx wrangler kv namespace create STATE
```

把輸出裡的 `id` 貼到 `wrangler.toml` 的 `REPLACE_WITH_KV_NAMESPACE_ID`。

### 3. 建立 GitHub token

到 [New fine-grained token](https://github.com/settings/personal-access-tokens/new)：

- **Resource owner**：`my-site`
- **Repository access**：Only select repositories → `my-site.github.io`
- **Repository permissions**：Contents「Read and write」、Issues「Read and write」、Pull requests「Read and write」（Metadata 會自動變成 Read-only）

組織若要求審核 fine-grained token，到[組織的 token 設定](https://github.com/organizations/my-site/settings/personal-access-token-requests)核准。
這個 token 的擁有者就是開 issue、留言、合併 PR 的身分；它必須是 repo 協作者，workflow 才會被觸發。

### 4. 設定 secrets

逐一執行，每次會要你貼上值。第一次會問 `There doesn't seem to be a Worker called "line-dispatch"...`，回答 `y`（先建一個空的 Worker 存 secret，第 5 步部署時程式會放進去，secret 保留）：

```powershell
npx wrangler secret put LINE_CHANNEL_SECRET         # LINE Developers → channel → Basic settings
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN   # LINE Developers → channel → Messaging API（long-lived）
npx wrangler secret put APPROVER_USER_ID            # 你自己的 userId（Basic settings 最下方 Your user ID）
npx wrangler secret put ALLOWED_USER_IDS            # 能提修改的人，逗號分隔；先只填你自己
npx wrangler secret put GITHUB_TOKEN                # 第 3 步的 token
npx wrangler secret put GITHUB_WEBHOOK_SECRET       # 自己產生一串亂數，第 7 步也要填同一串
```

亂數可以這樣產生：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 5. 部署

```powershell
npm test                    # 先跑測試
npx wrangler deploy
```

輸出會有 Worker 網址，形如 `https://line-dispatch.<你的子網域>.workers.dev`。打開它應該看到 `line-dispatch ok`。

### 6. 接上 LINE

[LINE Developers Console](https://developers.line.biz/console/) → channel →「Messaging API」分頁：

- **Webhook URL**：`<Worker 網址>/line/webhook`
- 按 **Verify** 看到 Success，打開 **Use webhook**

### 7. 接上 GitHub

[repo 的 Webhooks](https://github.com/my-org/my-site/settings/hooks) → Add webhook：

- **Payload URL**：`<Worker 網址>/github/webhook`
- **Content type**：`application/json`
- **Secret**：第 4 步的 `GITHUB_WEBHOOK_SECRET`
- **Which events**：Let me select individual events → 勾 **Issue comments**、**Issues**、**Pull requests**（其他取消勾選）

### 8. 加入店裡的人

1. 請對方加 bot 為好友。
2. 你這邊執行 `npm run tail`（即時看 Worker 紀錄），會出現 `[加好友] userId=U…`；
   對方若已經是好友，請他隨便傳一句，會出現 `[未授權，略過] userId=U…`。
3. 把那個 userId 加進白名單：`npx wrangler secret put ALLOWED_USER_IDS`，填入「你的 userId,對方的 userId」。

## 開發

```powershell
npm test          # 自動測試：簽章、白名單、批准權限、通知時機、排程補送…
npm run dev       # 本機跑 Worker（需先把 .dev.vars.example 複製成 .dev.vars 並填值）
npm run tail      # 看線上 Worker 的即時紀錄
```

## 已知限制

- 每件修改的「改好了」只有 workflow 的回報這一個來源，所以不會有兩個事件同時改同一筆紀錄的問題。
- 每件大約會用掉 3～4 則 push（改好通知、上線通知）；LINE 輕用量方案每月 200 則。
- 追加修改的判定只看「同一人有沒有未結案的件」。要提另一件不相關的修改，得等前一件上線或退回。
