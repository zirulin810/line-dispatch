// 件的狀態存在 KV。
//
//   user:<LINE userId>  → 這個人目前未結案的 issue 編號
//   req:<issue 編號>    → 件的資料（見 newRequest）
//
// 一件可以有很多「輪」：開件是第 1 輪，之後每則追加訊息開新的一輪。
// 每一輪都要等兩個訊號才通知：workflow 回報改好（ready）＋ Cloudflare Pages 部署完成（deployed）。
// 兩個訊號到的順序不一定，所以各自記下，湊齊才送。

export function newRequest({ issue, userId, name, now }) {
  return {
    issue,
    userId,
    name,
    state: "open", // open | merged | closed
    pr: null,
    branch: `line/${issue}`,
    round: newRound(now),
  };
}

export function newRound(now) {
  return {
    id: String(now), // 放進［上線］按鈕，舊輪的按鈕按了不算數
    startedAt: now,
    status: "working", // working | ready | question | nochange | error
    readyAt: null,
    summary: null,
    deployedAt: null,
    previewUrl: null,
    notified: false,
  };
}

export function store(kv) {
  return {
    async getRequest(issue) {
      return kv.get(`req:${issue}`, "json");
    },
    async putRequest(req) {
      await kv.put(`req:${req.issue}`, JSON.stringify(req));
    },
    async openIssueOf(userId) {
      const v = await kv.get(`user:${userId}`);
      return v ? Number(v) : null;
    },
    async setOpenIssue(userId, issue) {
      await kv.put(`user:${userId}`, String(issue));
    },
    async clearOpenIssue(userId, issue) {
      // 只清掉還指向這件的對應，避免誤刪對方新開的件
      if ((await this.openIssueOf(userId)) === issue) await kv.delete(`user:${userId}`);
    },
    async listOpenRequests() {
      const out = [];
      let cursor;
      do {
        const page = await kv.list({ prefix: "req:", cursor });
        for (const { name } of page.keys) {
          const req = await kv.get(name, "json");
          if (req?.state === "open") out.push(req);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return out;
    },
  };
}
