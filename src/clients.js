// 對外 API 的薄包裝。fetch 由呼叫端注入，測試時可換成假的。

const LINE_API = "https://api.line.me/v2/bot";
const GITHUB_API = "https://api.github.com";

export function lineClient(env, fetchImpl = fetch) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
  };
  async function post(path, payload) {
    const res = await fetchImpl(`${LINE_API}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`LINE ${path} ${res.status}: ${await res.text()}`);
    return res.ok;
  }
  return {
    // reply 不計入每月訊息額度，但 reply token 只能用一次、約一分鐘內有效
    reply: (replyToken, messages) => post("/message/reply", { replyToken, messages }),
    // push 計入額度；一次呼叫帶多則訊息只算一則
    push: (to, messages) => post("/message/push", { to, messages }),
    // bot 被拉進群組或多人聊天室時自己退出（只用私訊）
    async leave(source) {
      const path = source.groupId ? `/group/${source.groupId}/leave` : `/room/${source.roomId}/leave`;
      const res = await fetchImpl(`${LINE_API}${path}`, { method: "POST", headers });
      if (!res.ok) console.error(`LINE ${path} ${res.status}: ${await res.text()}`);
      return res.ok;
    },
    async displayName(userId) {
      const res = await fetchImpl(`${LINE_API}/profile/${userId}`, { headers });
      if (!res.ok) return null;
      return (await res.json()).displayName ?? null;
    },
  };
}

export function githubClient(env, fetchImpl = fetch, repo) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "line-dispatch-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  async function call(method, path, payload) {
    const res = await fetchImpl(`${GITHUB_API}/repos/${repo}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) console.error(`GitHub ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    return { ok: res.ok, status: res.status, data };
  }
  return {
    createIssue: (title, body, labels) => call("POST", "/issues", { title, body, labels }),
    getIssue: (n) => call("GET", `/issues/${n}`),
    listComments: (n, sinceIso) =>
      call("GET", `/issues/${n}/comments?per_page=100&since=${encodeURIComponent(sinceIso)}`),
    comment: (n, body) => call("POST", `/issues/${n}/comments`, { body }),
    closeIssue: (n) => call("PATCH", `/issues/${n}`, { state: "closed", state_reason: "not_planned" }),
    mergePr: (pr, title) =>
      call("PUT", `/pulls/${pr}/merge`, { merge_method: "squash", commit_title: title }),
    closePr: (pr) => call("PATCH", `/pulls/${pr}`, { state: "closed" }),
    deleteBranch: (branch) => call("DELETE", `/git/refs/heads/${branch}`),
  };
}
