import { test } from "node:test";
import assert from "node:assert/strict";
import { handleFetch, handleScheduled, makeDeps, parseMarker, previewUrlFor } from "../src/index.js";
import { signLine } from "../src/crypto.js";
import {
  ADMIN, STAFF, STRANGER, SITE, REPO,
  makeEnv, setup, textEvent, followEvent, postbackEvent, groupEvent, workflowComment, readyBody,
  pushes, replies, replyText, ghCalls, createdIssues, comments, merges,
} from "./helpers.js";

const T0 = Date.parse("2026-09-28T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const decide = (a, round, n = 7) => `a=${a}&s=${SITE.id}&n=${n}&r=${round}`;

// 已審核的 STAFF 開一件，並跑到「已通知、等上線」；回傳這一輪的 id
async function readyRequest(t, { requester = STAFF } = {}) {
  if (requester !== ADMIN) await t.approve(requester);
  await t.line([textEvent(requester, "營業時間改成週日公休")]);
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  return (await t.env.STATE.get(`req:${SITE.id}:7`, "json")).round.id;
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
  assert.equal((await t.line([])).status, 200);
});

test("LINE 重送的事件略過，不會重複開件", async () => {
  const t = setup();
  await t.approve(STAFF);
  const ev = textEvent(STAFF, "營業時間改成週日公休");
  ev.deliveryContext.isRedelivery = true;
  await t.line([ev]);
  assert.equal(createdIssues(t.calls).length, 0);
});

// ── 好友審核 ──

test("陌生人加好友 → 通知管理者（名字＋網站／忽略按鈕），對方收到「已通知管理員」", async () => {
  const t = setup();
  await t.line([followEvent(STRANGER)]);
  const [toAdmin] = pushes(t.calls, ADMIN);
  const [text, buttons] = toAdmin.body.messages;
  assert.match(text.text, /新好友：路人/);
  assert.deepEqual(buttons.template.actions.map((a) => a.label), ["範例網站", "忽略"]);
  assert.match(replyText(t.calls), /已經通知管理員/);
  assert.equal((await t.env.STATE.get(`member:${STRANGER}`, "json")).status, "pending");
  assert.equal(createdIssues(t.calls).length, 0);
});

test("已經是好友、沒審核過的人第一次傳訊息 → 通知管理者，不開件；再傳也只通知一次", async () => {
  const t = setup();
  await t.line([textEvent(STRANGER, "幫我改首頁")]);
  await t.line([textEvent(STRANGER, "哈囉？")]);
  assert.equal(pushes(t.calls, ADMIN).length, 1);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.match(replyText(t.calls, 1), /已經通知管理員/);
});

test("管理者按［範例網站］→ 對方收到使用說明，之後私訊直接開件", async () => {
  const t = setup();
  await t.line([followEvent(STRANGER)]);
  t.clearCalls();
  await t.line([postbackEvent(ADMIN, `a=grant&u=${STRANGER}&s=${SITE.id}`)]);
  assert.match(replyText(t.calls), /已開放 路人 修改範例網站/);
  assert.match(pushes(t.calls, STRANGER)[0].body.messages[0].text, /可以用 LINE 修改範例網站/);
  t.clearCalls();
  await t.line([textEvent(STRANGER, "營業時間改成週日公休")]);
  assert.equal(createdIssues(t.calls).length, 1);
  assert.equal(createdIssues(t.calls)[0].url, `https://api.github.com/repos/${REPO}/issues`);
});

test("管理者按［忽略］→ 之後的訊息不理、不再通知", async () => {
  const t = setup();
  await t.line([followEvent(STRANGER)]);
  await t.line([postbackEvent(ADMIN, `a=ignore&u=${STRANGER}`)]);
  t.clearCalls();
  await t.line([textEvent(STRANGER, "幫我改首頁")]);
  await t.line([followEvent(STRANGER)]);
  assert.equal(t.calls.length, 0);
});

test("不是管理者按審核按鈕 → 拒絕", async () => {
  const t = setup();
  await t.line([followEvent(STRANGER)]);
  t.clearCalls();
  await t.line([postbackEvent(STRANGER, `a=grant&u=${STRANGER}&s=${SITE.id}`)]);
  assert.match(replyText(t.calls), /只有管理員/);
  assert.equal((await t.env.STATE.get(`member:${STRANGER}`, "json")).status, "pending");
});

test("管理者自己傳訊息不用審核，直接開件", async () => {
  const t = setup();
  await t.line([textEvent(ADMIN, "營業時間改成週日公休")]);
  assert.equal(createdIssues(t.calls).length, 1);
  assert.equal(pushes(t.calls, ADMIN).length, 0);
});

// ── 只用私訊 ──

test("被拉進群組 → 自動退出，不處理群組訊息", async () => {
  const t = setup();
  await t.line([groupEvent("join"), groupEvent("message")]);
  assert.equal(t.calls.filter((c) => c.url.endsWith("/group/C_group/leave")).length, 2);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.equal(pushes(t.calls).length, 0);
});

// ── 開件與追加 ──

test("開件：帶標籤的 issue、回「收到」", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  const [created] = createdIssues(t.calls);
  assert.deepEqual(created.body.labels, ["line-request"]);
  assert.match(created.body.body, /來自 LINE：阿姨/);
  assert.match(replyText(t.calls), /收到，處理中（#7）/);
  assert.deepEqual(await t.env.STATE.get(`open:${STAFF}`, "json"), { site: SITE.id, issue: 7 });
});

test("還有未結案的件時再傳 → 留言到同一個 issue，不開新件", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.line([textEvent(STAFF, "字再大一點")]);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.match(comments(t.calls)[0].url, /\/issues\/7\/comments$/);
  assert.match(replyText(t.calls), /接著改 #7/);
});

test("舊件已在 GitHub 上關掉或刪掉 → 新訊息開新件", async () => {
  for (const opt of ["closedIssues", "deletedIssues"]) {
    const list = [];
    const t = setup({ [opt]: list });
    await t.approve(STAFF);
    await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
    list.push(7);
    t.clearCalls();
    await t.line([textEvent(STAFF, "電話改成 06-1234567")]);
    assert.equal(comments(t.calls).length, 0, opt);
    assert.equal(createdIssues(t.calls).length, 1, opt);
    assert.match(replyText(t.calls), /#8/, opt);
  }
});

test("非文字訊息 → 回覆只看得懂文字", async () => {
  const t = setup();
  await t.approve(STAFF);
  const ev = textEvent(STAFF, "");
  ev.message = { type: "image", id: "1" };
  await t.line([ev]);
  assert.equal(createdIssues(t.calls).length, 0);
  assert.match(replyText(t.calls), /文字/);
});

// ── 改好通知 ──

test("workflow 回報改好 → 只推給提出者（含按鈕），管理者不會收到", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  const [toStaff] = pushes(t.calls, STAFF);
  const [text, buttons] = toStaff.body.messages;
  assert.match(text.text, /範例網站 #7 改好了/);
  assert.match(text.text, /週日公休/);
  assert.match(text.text, /https:\/\/line-7\.my-site\.pages\.dev/);
  assert.doesNotMatch(text.text, /line-request:status|PR：/);
  assert.deepEqual(buttons.template.actions.map((a) => a.label), ["看預覽", "上線", "退回"]);
  assert.equal(pushes(t.calls, ADMIN).length, 0);
});

test("同一則回報重送 → 只通知一次", async () => {
  const t = setup();
  await readyRequest(t);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  assert.equal(pushes(t.calls).length, 0);
});

test("別的 repo 或別人假冒的回報 → 不理", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)), { repo: "someone/else" });
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000), "someone"));
  assert.equal(pushes(t.calls).length, 0);
});

test("上一輪的舊回報不算這一輪", async () => {
  const t = setup();
  await readyRequest(t);
  t.setNow(T0 + 10 * 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7), iso(T0 + 60_000)));
  assert.equal(pushes(t.calls).length, 0);
  await t.github("issue_comment", workflowComment(7, readyBody(12, 7, "字放大了"), iso(T0 + 11 * 60_000)));
  assert.match(pushes(t.calls, STAFF)[0].body.messages[0].text, /字放大了/);
});

test("workflow 反問 → 推給提出者", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "那個字改大一點")]);
  t.clearCalls();
  await t.github("issue_comment", workflowComment(7, "<!-- line-request:status=question -->\n請問是哪一頁？", iso(T0 + 60_000)));
  assert.match(pushes(t.calls, STAFF)[0].body.messages[0].text, /哪一頁/);
  assert.equal(pushes(t.calls, ADMIN).length, 0);
});

test("workflow 失敗 → 通知提出者與管理者", async () => {
  const t = setup();
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  t.clearCalls();
  const body = "<!-- line-request:status=error -->\n沒有完成\n\n執行紀錄：https://github.com/x/actions/runs/1";
  await t.github("issue_comment", workflowComment(7, body, iso(T0 + 60_000)));
  assert.equal(pushes(t.calls, STAFF).length, 1);
  assert.match(pushes(t.calls, ADMIN)[0].body.messages[0].text, /範例網站 #7 執行失敗[\s\S]*actions\/runs\/1/);
});

// ── 上線權限 ──

test("提出者按［上線］→ 合併、刪分支；提出者收到已上線，管理者收到「網站 用戶 上線＋變更連結」", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("approve", round))]);
  const [merge] = merges(t.calls);
  assert.equal(merge.url, `https://api.github.com/repos/${REPO}/pulls/12/merge`);
  assert.equal(ghCalls(t.calls, "DELETE", "/git/refs/heads/line/7").length, 1);
  assert.match(replyText(t.calls), /已上線/);
  const [toAdmin] = pushes(t.calls, ADMIN);
  assert.equal(
    toAdmin.body.messages[0].text,
    `範例網站 阿姨 上線\n上線內容：https://github.com/${REPO}/pull/12/files`,
  );
  assert.equal((await t.env.STATE.get(`req:${SITE.id}:7`, "json")).state, "merged");
  assert.equal(await t.env.STATE.get(`open:${STAFF}`), null);

  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("approve", round))]); // 重按
  assert.equal(merges(t.calls).length, 0);
  assert.match(replyText(t.calls), /已經處理過/);
});

test("不是提出者按［上線］（包括管理者）→ 拒絕，不合併", async () => {
  for (const who of [ADMIN, STRANGER]) {
    const t = setup();
    const round = await readyRequest(t);
    t.clearCalls();
    await t.line([postbackEvent(who, decide("approve", round))]);
    assert.equal(merges(t.calls).length, 0, who);
    assert.match(replyText(t.calls), /只有提出這件修改的人/, who);
  }
});

test("按舊一輪的［上線］→ 不合併", async () => {
  const t = setup();
  const oldRound = await readyRequest(t);
  t.setNow(T0 + 10 * 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("approve", oldRound))]);
  assert.equal(merges(t.calls).length, 0);
  assert.match(replyText(t.calls), /比較舊的預覽/);
});

test("合併失敗 → 告知提出者並通知管理者，件保持開著", async () => {
  const t = setup({ mergeOk: false });
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("approve", round))]);
  assert.match(replyText(t.calls), /上線失敗/);
  assert.match(pushes(t.calls, ADMIN)[0].body.messages[0].text, /合併失敗/);
  assert.equal((await t.env.STATE.get(`req:${SITE.id}:7`, "json")).state, "open");
});

test("提出者按［退回］→ 關 PR 與 issue、刪分支，不通知管理者", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("reject", round))]);
  assert.equal(merges(t.calls).length, 0);
  assert.equal(ghCalls(t.calls, "PATCH", "/pulls/12")[0].body.state, "closed");
  assert.equal(ghCalls(t.calls, "PATCH", "/issues/7")[0].body.state, "closed");
  assert.match(replyText(t.calls), /沒有上線/);
  assert.equal(pushes(t.calls).length, 0);
});

test("管理者自己提的件：上線內容附在回覆裡，不另外推播", async () => {
  const t = setup();
  const round = await readyRequest(t, { requester: ADMIN });
  t.clearCalls();
  await t.line([postbackEvent(ADMIN, decide("approve", round))]);
  assert.equal(merges(t.calls).length, 1);
  assert.match(replyText(t.calls), /已上線[\s\S]*範例網站 哈咪瓜 上線\n上線內容：/);
  assert.equal(pushes(t.calls).length, 0);
});

// ── 舊資料相容（改版前開的件）──

test("改版前的件（舊的 KV 鍵、沒有網站欄位）能繼續追加、收通知、上線", async () => {
  const t = setup();
  await t.approve(STAFF);
  // 模擬改版前留下的資料
  await t.env.STATE.put("user:" + STAFF, "10");
  await t.env.STATE.put("req:10", JSON.stringify({
    issue: 10, userId: STAFF, name: "阿姨", state: "open", pr: null, branch: "line/10",
    round: { id: "1", startedAt: T0, status: "working", readyAt: null, summary: null, previewUrl: null, notified: false },
  }));
  t.setNow(T0 + 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]);
  assert.match(comments(t.calls)[0].url, /\/issues\/10\/comments$/);
  assert.equal(await t.env.STATE.get("req:10"), null); // 已搬到新鍵
  const moved = await t.env.STATE.get(`req:${SITE.id}:10`, "json");
  assert.equal(moved.site, SITE.id);

  await t.github("issue_comment", workflowComment(10, readyBody(11, 10), iso(T0 + 2 * 60_000)));
  const round = (await t.env.STATE.get(`req:${SITE.id}:10`, "json")).round.id;
  t.clearCalls();
  await t.line([postbackEvent(STAFF, decide("approve", round, 10))]);
  assert.equal(merges(t.calls).length, 1);
  assert.equal(await t.env.STATE.get("user:" + STAFF), null);
});

test("改版前發出的［上線］按鈕（沒有帶網站）也能用", async () => {
  const t = setup();
  const round = await readyRequest(t);
  t.clearCalls();
  await t.line([postbackEvent(STAFF, `a=approve&n=7&r=${round}`)]);
  assert.equal(merges(t.calls).length, 1);
});

// ── 在 GitHub 上直接處理 ──

test("直接在 GitHub 合併 PR → 同步狀態並通知提出者", async () => {
  const t = setup();
  await readyRequest(t);
  t.clearCalls();
  await t.github("pull_request", { action: "closed", pull_request: { merged: true, head: { ref: "line/7" } } });
  assert.equal((await t.env.STATE.get(`req:${SITE.id}:7`, "json")).state, "merged");
  assert.equal(pushes(t.calls, STAFF).length, 1);
  assert.equal(await t.env.STATE.get(`open:${STAFF}`), null);
});

// ── 排程對帳 ──

test("回報的 webhook 漏接 → 排程去 GitHub 讀留言補送（含舊資料）", async () => {
  const comments7 = [];
  const t = setup({ issueComments: { 7: comments7 } });
  await t.approve(STAFF);
  await t.line([textEvent(STAFF, "營業時間改成週日公休")]);
  comments7.push({ user: { login: "github-actions[bot]" }, body: readyBody(12, 7), created_at: iso(T0 + 60_000) });
  t.clearCalls();

  t.setNow(T0 + 3 * 60_000);
  await handleScheduled(t.env, t.deps);
  assert.equal(ghCalls(t.calls, "GET", "/comments").length, 0); // 還不到對帳時間

  t.setNow(T0 + 10 * 60_000);
  await handleScheduled(t.env, t.deps);
  assert.equal(pushes(t.calls, STAFF)[0].body.messages[1].template.actions[1].label, "上線");
  await handleScheduled(t.env, t.deps);
  assert.equal(pushes(t.calls, STAFF).length, 1); // 不重複
});

test("排程對帳時忽略上一輪的舊回報", async () => {
  const comments7 = [];
  const t = setup({ issueComments: { 7: comments7 } });
  await readyRequest(t);
  comments7.push({ user: { login: "github-actions[bot]" }, body: readyBody(12, 7), created_at: iso(T0 + 60_000) });
  t.setNow(T0 + 10 * 60_000);
  await t.line([textEvent(STAFF, "字再大一點")]);
  t.clearCalls();
  t.setNow(T0 + 20 * 60_000);
  await handleScheduled(t.env, t.deps);
  assert.equal(pushes(t.calls).length, 0);
});

// ── 小工具 ──

test("parseMarker 解析狀態、PR、分支、預覽，並去掉標記與 PR／預覽行", () => {
  const m = parseMarker(readyBody(12, 7, "改好了"));
  assert.equal(m.status, "ready");
  assert.equal(m.pr, "12");
  assert.equal(m.branch, "line/7");
  assert.equal(m.preview, "https://line-7.my-site.pages.dev");
  assert.equal(m.text, "改好了");
  assert.equal(parseMarker("一般留言"), null);
});

test("previewUrlFor 依 Cloudflare 規則轉分支名", () => {
  assert.equal(previewUrlFor(SITE, "line/7"), "https://line-7.my-site.pages.dev");
  assert.equal(previewUrlFor(SITE, "Fix/API"), "https://fix-api.my-site.pages.dev");
});

// ── 回應時機 ──

test("LINE webhook 先回 200，GitHub 呼叫在背景做完（不會因 LINE 斷線而被取消）", async () => {
  const env = makeEnv();
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const slowFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("api.github.com")) await gate;
    const data = String(url).endsWith("/issues") ? { number: 7 } : { displayName: "阿姨" };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const deps = makeDeps(env, slowFetch, () => T0);
  const ctx = { tasks: [], waitUntil(p) { this.tasks.push(p); } };

  const body = JSON.stringify({ events: [textEvent(ADMIN, "營業時間改成週日公休")] });
  const req = new Request("https://w.example/line/webhook", {
    method: "POST", body, headers: { "x-line-signature": await signLine(env.LINE_CHANNEL_SECRET, body) },
  });
  const res = await handleFetch(req, env, deps, ctx);
  assert.equal(res.status, 200);
  assert.equal(ctx.tasks.length, 1);
  assert.ok(!calls.some((u) => u.endsWith("/message/reply")));

  release();
  await Promise.all(ctx.tasks);
  assert.ok(calls.some((u) => u.endsWith("/message/reply")));
});
