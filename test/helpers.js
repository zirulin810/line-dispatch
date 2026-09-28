// 測試用的假 KV、假 fetch 與事件產生器

import { handleFetch, makeDeps } from "../src/index.js";
import { signGithub, signLine } from "../src/crypto.js";

export const APPROVER = "U_approver";
export const STAFF = "U_staff";
export const STRANGER = "U_stranger";

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
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

export function makeEnv() {
  return {
    STATE: fakeKV(),
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    APPROVER_USER_ID: APPROVER,
    ALLOWED_USER_IDS: `${APPROVER}, ${STAFF}`,
    GITHUB_TOKEN: "gh-token",
    GITHUB_WEBHOOK_SECRET: "gh-secret",
    GITHUB_REPO: "my-org/my-site",
    PAGES_PROJECT: "my-site",
    ISSUE_LABEL: "line-request",
  };
}

// 記錄所有對外呼叫，依網址回假資料
export function fakeFetch({ nextIssue = 7, mergeOk = true, closedIssues = [] } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body });
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (String(url).includes("/profile/")) return json({ displayName: "阿姨" });
    if (String(url).endsWith("/issues") && method === "POST") return json({ number: nextIssue++ }, 201);
    const issueGet = method === "GET" && /\/issues\/(\d+)$/.exec(String(url));
    if (issueGet) return json({ state: closedIssues.includes(Number(issueGet[1])) ? "closed" : "open" });
    if (String(url).includes("/merge")) return mergeOk ? json({ merged: true }) : json({ message: "conflict" }, 405);
    return json({});
  };
  return { impl, calls };
}

export function setup(opts = {}) {
  const env = makeEnv();
  const f = fakeFetch(opts);
  f.closedIssues = opts.closedIssues;
  let clock = opts.now ?? Date.parse("2026-09-28T10:00:00Z");
  const deps = makeDeps(env, f.impl, () => clock);
  return {
    env,
    deps,
    calls: f.calls,
    setNow: (t) => (clock = t),
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
    async github(event, payload, { signature } = {}) {
      const body = JSON.stringify(payload);
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
  };
}

// ── 事件產生器 ──
export const textEvent = (userId, text) => ({
  type: "message",
  replyToken: `rt-${Math.random()}`,
  source: { type: "user", userId },
  message: { type: "text", id: "1", text },
  deliveryContext: { isRedelivery: false },
});

export const postbackEvent = (userId, data) => ({
  type: "postback",
  replyToken: `rt-${Math.random()}`,
  source: { type: "user", userId },
  postback: { data },
  deliveryContext: { isRedelivery: false },
});

export const workflowComment = (issue, body, createdAt, login = "github-actions[bot]") => ({
  action: "created",
  issue: { number: issue },
  comment: { user: { login }, body, created_at: createdAt },
});

export const pagesCheckRun = (branch, completedAt, conclusion = "success") => ({
  action: "completed",
  check_run: {
    app: { slug: "cloudflare-workers-and-pages", name: "Cloudflare Workers and Pages" },
    conclusion,
    completed_at: completedAt,
    check_suite: { head_branch: branch },
  },
});

export const readyBody = (pr, issue, summary = "把關於我們的營業時間改成週日公休。") =>
  `<!-- line-request:status=ready;pr=${pr};branch=line/${issue} -->\n${summary}\n\nPR：#${pr}（預覽網址會由 Cloudflare Pages 貼在 PR 上）`;

// 篩出某種呼叫
export const pushes = (calls, to) =>
  calls.filter((c) => c.url.endsWith("/message/push") && (!to || c.body.to === to));
export const replies = (calls) => calls.filter((c) => c.url.endsWith("/message/reply"));
export const ghCalls = (calls, method, pathPart) =>
  calls.filter((c) => c.url.includes("api.github.com") && c.method === method && c.url.includes(pathPart));
