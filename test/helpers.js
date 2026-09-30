// 測試用的假 KV、假 fetch 與事件產生器

import { handleFetch, makeDeps } from "../src/index.js";
import { signGithub, signLine } from "../src/crypto.js";

export const ADMIN = "U_admin";
export const STAFF = "U_staff";
export const STRANGER = "U_stranger";
export const REPO = "my-org/my-site";
export const SITE = { id: "mysite", name: "範例網站", repo: REPO, pagesProject: "my-site" };

export function fakeKV() {
  const m = new Map();
  return {
    map: m,
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      m.set(key, value);
    },
    async delete(key) {
      m.delete(key);
    },
    async list({ prefix }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

export function makeEnv() {
  return {
    STATE: fakeKV(),
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    ADMIN_USER_ID: ADMIN,
    GITHUB_TOKEN: "gh-token",
    GITHUB_WEBHOOK_SECRET: "gh-secret",
    ISSUE_LABEL: "line-request",
    SITES: [SITE],
  };
}

// 記錄所有對外呼叫，依網址回假資料
export function fakeFetch({ nextIssue = 7, mergeOk = true, closedIssues = [], deletedIssues = [], issueComments = {} } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const u = String(url);
    calls.push({ url: u, method, body });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    const names = { [STAFF]: "阿姨", [STRANGER]: "路人", [ADMIN]: "哈咪瓜" };
    const profile = /\/profile\/([^/]+)$/.exec(u);
    if (profile) return json({ displayName: names[profile[1]] ?? "某人" });
    if (u.endsWith("/issues") && method === "POST") return json({ number: nextIssue++ }, 201);
    const commentList = method === "GET" && /\/issues\/(\d+)\/comments\?/.exec(u);
    if (commentList) return json(issueComments[commentList[1]] ?? []);
    const issueGet = method === "GET" && /\/issues\/(\d+)$/.exec(u);
    if (issueGet && deletedIssues.includes(Number(issueGet[1]))) return json({ message: "Not Found" }, 404);
    if (issueGet) return json({ state: closedIssues.includes(Number(issueGet[1])) ? "closed" : "open" });
    if (u.includes("/merge")) return mergeOk ? json({ merged: true }) : json({ message: "conflict" }, 405);
    return json({});
  };
  return { impl, calls };
}

export function setup(opts = {}) {
  const env = makeEnv();
  const f = fakeFetch(opts);
  let clock = opts.now ?? Date.parse("2026-09-28T10:00:00Z");
  const deps = makeDeps(env, f.impl, () => clock);
  const t = {
    env,
    deps,
    calls: f.calls,
    setNow: (v) => (clock = v),
    clearCalls: () => (f.calls.length = 0),
    async line(events, { signature } = {}) {
      const body = JSON.stringify({ destination: "x", events });
      const sig = signature ?? (await signLine(env.LINE_CHANNEL_SECRET, body));
      return handleFetch(
        new Request("https://w.example/line/webhook", { method: "POST", body, headers: { "x-line-signature": sig } }),
        env,
        deps,
      );
    },
    async github(event, payload, { signature, repo = REPO } = {}) {
      const body = JSON.stringify({ repository: { full_name: repo }, ...payload });
      const sig = signature ?? (await signGithub(env.GITHUB_WEBHOOK_SECRET, body));
      return handleFetch(
        new Request("https://w.example/github/webhook", {
          method: "POST",
          body,
          headers: { "x-hub-signature-256": sig, "x-github-event": event },
        }),
        env,
        deps,
      );
    },
    // 讓某人通過審核（直接寫 KV，省得每個測試都走一遍審核流程）
    async approve(userId, name = "阿姨") {
      await env.STATE.put(`member:${userId}`, JSON.stringify({ name, status: "approved", sites: [SITE.id] }));
    },
  };
  return t;
}

// ── 事件產生器（預設是私訊）──
const base = (userId, extra = {}) => ({
  replyToken: `rt-${Math.random()}`,
  source: { type: "user", userId },
  deliveryContext: { isRedelivery: false },
  ...extra,
});

export const textEvent = (userId, text) => ({
  type: "message",
  ...base(userId),
  message: { type: "text", id: "1", text },
});

export const followEvent = (userId) => ({ type: "follow", ...base(userId) });

export const postbackEvent = (userId, data) => ({ type: "postback", ...base(userId), postback: { data } });

export const groupEvent = (type, groupId = "C_group") => ({
  type,
  replyToken: `rt-${Math.random()}`,
  source: { type: "group", groupId, userId: STAFF },
  message: type === "message" ? { type: "text", id: "1", text: "hi" } : undefined,
  deliveryContext: { isRedelivery: false },
});

export const workflowComment = (issue, body, createdAt, login = "github-actions[bot]") => ({
  action: "created",
  issue: { number: issue },
  comment: { user: { login }, body, created_at: createdAt },
});

export const readyBody = (pr, issue, summary = "把關於我們的營業時間改成週日公休。",
  preview = `https://line-${issue}.my-site.pages.dev`) =>
  `<!-- line-request:status=ready;pr=${pr};branch=line/${issue};preview=${preview} -->\n${summary}\n\n預覽：${preview}\nPR：#${pr}`;

// ── 篩出某種呼叫 ──
export const pushes = (calls, to) =>
  calls.filter((c) => c.url.endsWith("/message/push") && (!to || c.body.to === to));
export const replies = (calls) => calls.filter((c) => c.url.endsWith("/message/reply"));
export const replyText = (calls, i = 0) => replies(calls)[i]?.body.messages.map((m) => m.text ?? "").join("\n");
export const ghCalls = (calls, method, pathPart) =>
  calls.filter((c) => c.url.includes("api.github.com") && c.method === method && c.url.includes(pathPart));
export const createdIssues = (calls) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
export const comments = (calls) => ghCalls(calls, "POST", "/comments");
export const merges = (calls) => ghCalls(calls, "PUT", "/merge");
