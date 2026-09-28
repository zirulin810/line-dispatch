import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFetch, handleScheduled, makeDeps, parseMarker, previewUrlFor } from "../src/index.js";
import { signLine } from "../src/crypto.js";
import {
  APPROVER, STAFF, STRANGER,
  makeEnv, setup, textEvent, postbackEvent, workflowComment, pagesCheckRun, readyBody,
  pushes, replies, ghCalls,
} from "./helpers.js";

const T0 = Date.parse("2026-09-28T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const createdIssues = (calls) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
const comments = (calls) => ghCalls(calls, "POST", "/comments");
const merges = (calls) => ghCalls(calls, "PUT", "/merge");

// 開一件並跑到「已通知、等批准」
async function readyRequest(t, { requester = STAFF } = {}) {
  await t.line([textEvent(requester, "營業時間改成週日公休")]);
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 90_000)));
  return (await t.env.STATE.get("req:7", "json")).round.id;
}

// ── 簽章 ──

test("LINE 簽章不符 → 401，什麼都不做", async () => {
  const t = setup();
  const res = await t.line([textEvent(STAFF, "hi")], { signature: "bogus" });
  assert.equal(res.status, 401);
  assert.equal(t.calls.length, 0);
});

test("LINE 沒帶簽章 → 401", async () => {
  const t = setup();
  const res = await t.line([textEvent(STAFF, "hi")], { signature: "" });
  assert.equal(res.status, 401);
  assert.equal(t.calls.length, 0);
});

test("GitHub 簽章不符 → 401，什麼都不做", async () => {
  const t = setup();
  const res = await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0)), { signature: "sha256=00" });
  assert.equal(res.status, 401);
  assert.equal(t.calls.length, 0);
});

test("LINE 的 Verify（空事件）回 200", async () => {
  const t = setup();
  const res = await t.line([]);
  assert.equal(res.status, 200);
});

// ── 白名單 ──

test("非白名單的人傳訊息 → 不開 issue、不回覆", async () => {
  const t = setup();
  const res = await t.line([textEvent(STRANGER, "幫我改首頁")]);
  assert.equal(res.status, 200);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.equal(replies(t.calls).length, 0);
});

test("LINE 重送的事件略過，不會重複開件", async () => {
  const t = setup();
  const ev = textEvent(STAFF, "營業時間改成週日公休");
  ev.deliveryContext.isRedelivery = true;
  await t.line([ev]);
  assert.equal(createdIssues(t.calls).length, 0);
});

// ── 開件與追加 ──

test("白名單的人傳訊息 → 開帶標籤的 issue 並回「收到」", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  const [created] = createdIssues(t.calls);
  assert.ok(created);
  assert.deepEqual(created.body.labels, ["line-request"]);
  assert.match(created.body.body, /營業時間改成週日公休/);
  assert.match(created.body.body, /來自 LINE：阿姨/);
  assert.match(replies(t.calls)[0].body.messages[0].text, /收到，處理中（#7）/);
  assert.equal(await t.env.STATE.get(`user:${STAFF}`), "7");
});

test("還有未結案的件時再傳 → 留言到同一個 issue，不開新件", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.line([textEvent(STAFF, "字再大一點")]);
  assert.equal(createdIssues(t.calls).length, 0);
  const [c] = comments(t.calls);
  assert.match(c.url, /\/issues\/7\/comments$/);
  assert.match(c.body.body, /字再大一點/);
  assert.match(replies(t.calls)[0].body.messages[0].text, /接著改 #7/);
});

test("舊件已在 GitHub 上關掉（關閉事件漏接）→ 新訊息開新件，不會卡在舊件", async () => {
  const closed = [];
  const t = setup({ closedIssues: closed });
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]); // 開 #7
  closed.push(7); // 有人直接在 GitHub 上關掉 #7，Worker 沒收到事件
  t.clearCalls();
  await t.line([textEvent(STAFF, "全站底色改成 #20C7B6")]);
  assert.equal(comments(t.calls).length, 0);
  assert.equal(createdIssues(t.calls).length, 1);
  assert.equal((await t.env.STATE.get("req:7", "json")).state, "closed");
  assert.equal(await t.env.STATE.get(`user:${STAFF}`), "8");
  assert.match(replies(t.calls)[0].body.messages[0].text, /#8/);
});

test("舊件還開著 → 照舊接著改（有先向 GitHub 確認）", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.line([textEvent(STAFF, "字再大一點")]);
  assert.equal(ghCalls(t.calls, "GET", "/issues/7").length, 1);
  assert.equal(comments(t.calls).length, 1);
  assert.equal(createdIssues(t.calls).length, 0);
});

test("非文字訊息 → 回覆只看得懂文字", async () => {
  const t = setup();
  const ev = textEvent(STAFF, "");
  ev.message = { type: "image", id: "1" };
  await t.line([ev]);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.match(replies(t.calls)[0].body.messages[0].text, /文字/);
});

// ── 改好通知 ──

test("只有 workflow 回報改好、預覽還沒好 → 先不通知", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  assert.equal(pushes(t.calls).length, 0);
});

test("改好＋預覽部署完成 → 推給我（含按鈕）與發訊息的人", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 90_000)));

  const [toMe] = pushes(t.calls, APPROVER);
  const [text, buttons] = toMe.body.messages;
  assert.match(text.text, /阿姨 的修改 #7 改好了/);
  assert.match(text.text, /週日公休/);
  assert.doesNotMatch(text.text, /line-request:status/);
  assert.match(text.text, /https:\/\/line-7\.my-site\.pages\.dev/);
  const labels = buttons.template.actions.map((a) => a.label);
  assert.deepEqual(labels, ["看預覽", "上線", "退回"]);

  const [toStaff] = pushes(t.calls, STAFF);
  assert.match(toStaff.body.messages[0].text, /line-7\.my-site\.pages\.dev/);
  assert.equal(toStaff.body.messages.length, 1); // 發訊息的人沒有按鈕
});

test("預覽先好、workflow 後回報 → 一樣會通知，而且只通知一次", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 50_000)));
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 70_000))); // 重複事件
  assert.equal(pushes(t.calls, APPROVER).length, 1);
  assert.equal(pushes(t.calls, STAFF).length, 1);
});

test("別人假冒 workflow 的標記留言 → 不理", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000), "someone"));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 90_000)));
  assert.equal(pushes(t.calls).length, 0);
});

test("上一輪的舊部署事件不算這一輪", async () => {
  const t = setup();
  await readyRequest(t);
  t.setNow(T0 + 10 * 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]); // 開第二輪
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7, "字放大了"), iso(T0 + 11 * 60_000)));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 90_000))); // 第一輪的
  assert.equal(pushes(t.calls).length, 0);
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 12 * 60_000)));
  assert.equal(pushes(t.calls, APPROVER).length, 1);
});

test("workflow 反問 → 把問題推給發訊息的人", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "那個字改大一點")]);
  t.clearCalls();
  const body = "<!-- line-request:status=question -->\n請問是哪一頁的哪一段字？";
  await t.github("issue_comment", workflowComment(7, body, iso(T0 + 60_000)));
  const [p] = pushes(t.calls, STAFF);
  assert.match(p.body.messages[0].text, /哪一頁的哪一段字/);
  assert.equal(pushes(t.calls, APPROVER).length, 0);
});

test("workflow 失敗 → 通知發訊息的人與我", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  const body = "<!-- line-request:status=error -->\n這次修改沒有完成\n\n執行紀錄：https://github.com/x/actions/runs/1";
  await t.github("issue_comment", workflowComment(7, body, iso(T0 + 60_000)));
  assert.equal(pushes(t.calls, STAFF).length, 1);
  assert.match(pushes(t.calls, APPROVER)[0].body.messages[0].text, /actions\/runs\/1/);
});

// ── 批准權限 ──

test("不是我按［上線］→ 拒絕，不合併", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, `a=approve&n=7&r=${round}`)]);
  assert.equal(merges(t.calls).length, 0);
  assert.match(replies(t.calls)[0].body.messages[0].text, /只有網站負責人/);
  assert.equal((await t.env.STATE.get("req:7", "json")).state, "open");
});

test("非白名單的人按［上線］→ 一樣拒絕", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STRANGER, `a=approve&n=7&r=${round}`)]);
  assert.equal(merges(t.calls).length, 0);
});

test("我按［上線］→ 合併 PR、刪分支、通知雙方；之後再傳訊息會開新件", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(APPROVER, `a=approve&n=7&r=${round}`)]);
  const [merge] = merges(t.calls);
  assert.match(merge.url, /\/pulls\/12\/merge$/);
  assert.equal(merge.body.merge_method, "squash");
  assert.equal(ghCalls(t.calls, "DELETE", "/git/refs/heads/line/7").length, 1);
  assert.match(replies(t.calls)[0].body.messages[0].text, /已上線/);
  assert.match(pushes(t.calls, STAFF)[0].body.messages[0].text, /已上線/);
  assert.equal((await t.env.STATE.get("req:7", "json")).state, "merged");
  assert.equal(await t.env.STATE.get(`user:${STAFF}`), null);

  t.clearCalls();
  await t.line([postbackEvent(APPROVER, `a=approve&n=7&r=${round}`)]); // 重按
  assert.equal(merges(t.calls).length, 0);
  assert.match(replies(t.calls)[0].body.messages[0].text, /已經處理過/);

  t.clearCalls();
  await t.line([textEvent(STAFF, "電話改成 06-1234567")]);
  assert.equal(createdIssues(t.calls).length, 1);
  assert.equal(comments(t.calls).length, 0);
});

test("按舊一輪的［上線］→ 不合併", async () => {
  const t = setup();
  const oldRound = await readyRequest(t);
  t.setNow(T0 + 10 * 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]);
  t.clearCalls();
  await t.line([postbackEvent(APPROVER, `a=approve&n=7&r=${oldRound}`)]);
  assert.equal(merges(t.calls).length, 0);
  assert.match(replies(t.calls)[0].body.messages[0].text, /比較舊的預覽/);
});

test("合併失敗（例如衝突）→ 回報失敗，件保持開著", async () => {
  const t = setup({ mergeOk: false });
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(APPROVER, `a=approve&n=7&r=${round}`)]);
  assert.match(replies(t.calls)[0].body.messages[0].text, /合併失敗/);
  assert.equal((await t.env.STATE.get("req:7", "json")).state, "open");
});

test("我按［退回］→ 關 PR 與 issue、刪分支、通知發訊息的人", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(APPROVER, `a=reject&n=7&r=${round}`)]);
  assert.equal(merges(t.calls).length, 0);
  assert.equal(ghCalls(t.calls, "PATCH", "/pulls/12")[0].body.state, "closed");
  assert.equal(ghCalls(t.calls, "PATCH", "/issues/7")[0].body.state, "closed");
  assert.match(pushes(t.calls, STAFF)[0].body.messages[0].text, /沒有上線/);
  assert.equal(await t.env.STATE.get(`user:${STAFF}`), null);
});

test("我自己提的件 → 只收到一則有按鈕的通知，不重複", async () => {
  const t = setup();
  await t.line([textEvent(APPROVER, "營業時間改成週日公休")]);
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  await t.github("check_run", pagesCheckRun("line/7", iso(T0 + 90_000)));
  assert.equal(pushes(t.calls, APPROVER).length, 1);
});

// ── 在 GitHub 上直接處理 ──

test("直接在 GitHub 合併 PR → 同步狀態並通知發訊息的人", async () => {
  const t = setup();
  await readyRequest(t);
  t.clearCalls();
  await t.github("pull_request", { action: "closed", pull_request: { merged: true, head: { ref: "line/7" } } });
  assert.equal((await t.env.STATE.get("req:7", "json")).state, "merged");
  assert.equal(pushes(t.calls, STAFF).length, 1);
  assert.equal(await t.env.STATE.get(`user:${STAFF}`), null);
});

// ── 排程補送 ──

test("預覽訊號一直沒來 → 排程在 4 分鐘後用推算的網址補送", async () => {
  const t = setup();
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  t.clearCalls();
  t.setNow(T0 + 2 * 60_000);
  await handleScheduled(t.env, t.deps);
  assert.equal(pushes(t.calls).length, 0); // 還沒到時間
  t.setNow(T0 + 6 * 60_000);
  await handleScheduled(t.env, t.deps);
  assert.match(pushes(t.calls, APPROVER)[0].body.messages[0].text, /line-7\.my-site\.pages\.dev/);
  await handleScheduled(t.env, t.deps);
  assert.equal(pushes(t.calls, APPROVER).length, 1); // 不重複
});

// ── 小工具 ──

test("parseMarker 解析狀態、PR、分支，並去掉標記與 PR 行", () => {
  const m = parseMarker(readyBody(12, 7, "改好了"));
  assert.equal(m.status, "ready");
  assert.equal(m.pr, "12");
  assert.equal(m.branch, "line/7");
  assert.equal(m.text, "改好了");
  assert.equal(parseMarker("一般留言"), null);
});

test("previewUrlFor 依 Cloudflare 規則轉分支名", () => {
  const env = { PAGES_PROJECT: "my-site" };
  assert.equal(previewUrlFor(env, "line/7"), "https://line-7.my-site.pages.dev");
  assert.equal(previewUrlFor(env, "Fix/API"), "https://fix-api.my-site.pages.dev");
});

// ── 回應時機 ──

test("LINE webhook 先回 200，GitHub 呼叫在背景做完（不會因 LINE 斷線而被取消）", async () => {
  const env = makeEnv();
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  // 假的 fetch：GitHub 呼叫要等 gate 放行才回應，模擬 API 很慢
  const slowFetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes("api.github.com")) await gate;
    const data = String(url).endsWith("/issues") ? { number: 7 } : { displayName: "阿姨" };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const deps = makeDeps(env, slowFetch, () => T0);
  const ctx = { tasks: [], waitUntil(p) { this.tasks.push(p); } };

  const body = JSON.stringify({ events: [textEvent(STAFF, "營業時間改成週日公休")] });
  const req = new Request("https://w.example/line/webhook", {
    method: "POST", body, headers: { "x-line-signature": await signLine(env.LINE_CHANNEL_SECRET, body) },
  });
  const res = await handleFetch(req, env, deps, ctx);
  assert.equal(res.status, 200);          // GitHub 還卡著，回應就已經出去了
  assert.equal(ctx.tasks.length, 1);
  assert.ok(!calls.some((u) => u.endsWith("/message/reply")));

  release();
  await Promise.all(ctx.tasks);            // 背景工作完成後，回覆照樣送出
  assert.ok(calls.some((u) => u.endsWith("/message/reply")));
});
