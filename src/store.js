// 狀態存在 KV。
//
//   member:<LINE userId>     → 這個人的審核狀態與開放的網站（見 newMember）
//   open:<LINE userId>       → 這個人目前未結案的件 { site, issue }
//   req:<網站 id>:<issue>    → 件的資料（見 newRequest）
//
// 改版前的舊鍵（req:<issue>、user:<userId>，都屬於第一個網站）讀得到，寫回時換成新鍵。
//
// 一件可以有很多「輪」：開件是第 1 輪，之後每則追加訊息開新的一輪。
// 每一輪在收到 workflow 的回報（預覽已部署好）時通知一次。

export function newMember({ name, now }) {
  return {
    name,
    status: "pending", // pending（已通知管理者，等審核）| approved | ignored
    sites: [], // 開放的網站 id
    requestedAt: now,
  };
}

export function newRequest({ site, issue, userId, name, now }) {
  return {
    site,
    issue,
    userId, // 提出者，也是唯一能按［上線］／［退回］的人
    name,
    state: "open", // open | merged | closed
    pr: null,
    branch: `line/${issue}`,
    round: newRound(now),
  };
}

export function newRound(now) {
  return {
    // 放進按鈕，舊輪的按鈕按了不算數（只在 LINE 這邊改，讀寫不會延遲）；加亂數避免同一毫秒撞號
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    startedAt: now,
    status: "working", // working | ready | question | nochange | error | cancel（對方說不做了，等他按取消）
    readyAt: null,
    summary: null,
    previewUrl: null,
    notified: false,
  };
}

export function store(kv, defaultSiteId) {
  const reqKey = (site, issue) => `req:${site}:${issue}`;

  return {
    // ── 成員 ──
    async getMember(userId) {
      return kv.get(`member:${userId}`, "json");
    },
    async putMember(userId, member) {
      await kv.put(`member:${userId}`, JSON.stringify(member));
    },

    // ── 件 ──
    async getRequest(site, issue) {
      let req = await kv.get(reqKey(site, issue), "json");
      if (!req && site === defaultSiteId) {
        req = await kv.get(`req:${issue}`, "json");
        if (req) req.migrateFrom = `req:${issue}`;
      }
      if (req) req.site ??= site;
      return req;
    },
    async putRequest(req) {
      const { migrateFrom, ...data } = req;
      await kv.put(reqKey(data.site, data.issue), JSON.stringify(data));
      if (migrateFrom) {
        await kv.delete(migrateFrom);
        delete req.migrateFrom;
      }
    },

    // ── 未結案的件 ──
    async openRequestOf(userId) {
      const cur = await kv.get(`open:${userId}`, "json");
      if (cur) return cur;
      const legacy = await kv.get(`user:${userId}`);
      return legacy ? { site: defaultSiteId, issue: Number(legacy) } : null;
    },
    async setOpenRequest(userId, site, issue) {
      await kv.put(`open:${userId}`, JSON.stringify({ site, issue }));
      await kv.delete(`user:${userId}`);
    },
    async clearOpenRequest(userId, site, issue) {
      // 只清掉還指向這件的對應，避免誤刪對方新開的件
      const cur = await this.openRequestOf(userId);
      if (cur?.site === site && cur?.issue === issue) {
        await kv.delete(`open:${userId}`);
        await kv.delete(`user:${userId}`);
      }
    },

    async listOpenRequests() {
      const found = new Map();
      let cursor;
      do {
        const page = await kv.list({ prefix: "req:", cursor });
        for (const { name } of page.keys) {
          const parts = name.split(":"); // req:<site>:<issue> 或舊的 req:<issue>
          const legacy = parts.length === 2;
          const req = await kv.get(name, "json");
          if (req?.state !== "open") continue;
          req.site ??= legacy ? defaultSiteId : parts[1];
          const id = `${req.site}:${req.issue}`;
          if (legacy) {
            if (found.has(id)) continue; // 新鍵優先
            req.migrateFrom = name;
          }
          found.set(id, req);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return [...found.values()];
    },
  };
}
