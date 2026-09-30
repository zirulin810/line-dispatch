// LINE 派工閘道
//
//   LINE（私訊）──訊息──▶ /line/webhook   ──開 issue／留言──▶ GitHub（網站 repo）
//   GitHub      ──事件──▶ /github/webhook ──改好了＋預覽──▶     LINE（提出者）
//   提出者按［上線］／［退回］──▶ 合併／關閉 PR；上線時通知管理者
//
// 誰能用：不在名單上的人加好友（或第一次傳訊息）時通知管理者，由管理者按鈕開放網站或忽略。
// 只用私訊：被拉進群組或多人聊天室就自己退出。
// 「改好了」只有一個來源：workflow 等 Cloudflare 預覽部署好之後，在 issue 留的那則回報。
//
// 流程細節與部署步驟見 README.md。

import { verifyGithubSignature, verifyLineSignature } from "./crypto.js";
import { githubClient, lineClient } from "./clients.js";
import { newMember, newRequest, newRound, store } from "./store.js";
import { defaultSite, previewUrlFor, siteById, siteByRepo, sites } from "./sites.js";
import { msg } from "./messages.js";

// GitHub 與 Cloudflare 的時鐘可能差一點，比對「這一輪之後才發生」時放寬 30 秒
const CLOCK_SKEW_MS = 30_000;
// 一輪開始後這麼久還沒收到 workflow 的回報，排程就直接去 GitHub 讀留言對帳（webhook 漏接時的保險）
const RECONCILE_AFTER_MS = 5 * 60_000;
const WORKFLOW_BOT = "github-actions[bot]";

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, makeDeps(env), ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env, makeDeps(env)));
  },
};

export function makeDeps(env, fetchImpl = fetch, now = () => Date.now()) {
  return {
    line: lineClient(env, fetchImpl),
    gh: (site) => githubClient(env, fetchImpl, site.repo),
    st: store(env.STATE, defaultSite(env)?.id),
    now,
  };
}

// 驗完簽章就立刻回 200，實際工作交給 ctx.waitUntil 在背景做完。
// LINE 等不了太久：若等所有 GitHub 呼叫做完才回應，LINE 會先斷線，
// Cloudflare 隨即取消這次執行，排在後面的回覆訊息就送不出去。
// （測試時不傳 ctx，就照舊等工作做完再回應，方便檢查結果。）
async function runInBackground(ctx, label, work) {
  const safe = work.catch((err) => console.error(`${label} 失敗：${err?.stack ?? err}`));
  if (ctx?.waitUntil) ctx.waitUntil(safe);
  else await safe;
}

export async function handleFetch(request, env, deps, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") return new Response("line-dispatch ok");
  if (request.method !== "POST") return new Response("Not found", { status: 404 });

  const body = await request.text();
  if (url.pathname === "/line/webhook") {
    if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature")))) {
      return new Response("Invalid signature", { status: 401 });
    }
    await runInBackground(ctx, "LINE webhook", handleLineEvents(JSON.parse(body).events ?? [], env, deps));
    return new Response("ok");
  }
  if (url.pathname === "/github/webhook") {
    if (!(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
      return new Response("Invalid signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event");
    await runInBackground(ctx, `GitHub ${event}`, handleGithubEvent(event, JSON.parse(body), env, deps));
    return new Response("ok");
  }
  return new Response("Not found", { status: 404 });
}

// ── LINE ────────────────────────────────────────────────

const isAdmin = (env, userId) => Boolean(userId) && userId === env.ADMIN_USER_ID;

export async function handleLineEvents(events, env, deps) {
  for (const ev of events) {
    // LINE 重送的事件已經處理過，略過以免重複開件
    if (ev.deliveryContext?.isRedelivery) continue;
    const source = ev.source ?? {};
    try {
      // 只用私訊：群組推播按人數計額度，被拉進去就退出
      if (source.type === "group" || source.type === "room") {
        await deps.line.leave(source);
        continue;
      }
      const userId = source.userId;
      if (!userId) continue;
      if (ev.type === "follow") await onFollow(ev, userId, env, deps);
      else if (ev.type === "message") await onMessage(ev, userId, env, deps);
      else if (ev.type === "postback") await onPostback(ev, userId, env, deps);
    } catch (err) {
      console.error(`處理 LINE 事件失敗：${err?.stack ?? err}`);
      if (ev.replyToken) await deps.line.reply(ev.replyToken, [msg.failed()]);
    }
  }
}

// 管理者可以改所有網站；其他人看審核結果
async function memberOf(env, deps, userId) {
  if (isAdmin(env, userId)) return { status: "approved", sites: sites(env).map((s) => s.id), name: null };
  return deps.st.getMember(userId);
}

async function onFollow(ev, userId, env, deps) {
  const member = await memberOf(env, deps, userId);
  if (member?.status === "approved") {
    const site = siteById(env, member.sites[0]) ?? defaultSite(env);
    return deps.line.reply(ev.replyToken, [msg.guide(site)]);
  }
  if (member?.status === "ignored") return;
  if (!member) await askAdmin(userId, env, deps);
  return deps.line.reply(ev.replyToken, [msg.waitingApproval()]);
}

async function onMessage(ev, userId, env, deps) {
  const member = await memberOf(env, deps, userId);
  if (member?.status === "ignored") return;
  if (member?.status !== "approved") {
    if (!member) await askAdmin(userId, env, deps); // 已經是好友、但沒被審核過的人：第一次傳訊息時才通知
    return deps.line.reply(ev.replyToken, [msg.waitingApproval()]);
  }
  if (ev.message?.type !== "text") return deps.line.reply(ev.replyToken, [msg.textOnly()]);
  const text = ev.message.text.trim();
  if (!text) return;
  // 綁定多個網站時選網站：之後的任務再做，目前用第一個開放的網站
  const site = siteById(env, member.sites[0]) ?? defaultSite(env);
  await handleText(ev, userId, site, text, env, deps);
}

// 通知管理者審核（同一人只通知一次：之後 member 已存在）
async function askAdmin(userId, env, deps) {
  const name = await deps.line.displayName(userId);
  await deps.st.putMember(userId, newMember({ name, now: deps.now() }));
  await deps.line.push(env.ADMIN_USER_ID, msg.approvalRequest(userId, name, sites(env)));
}

async function handleText(ev, userId, site, text, env, deps) {
  const { line, st, now } = deps;
  const gh = deps.gh(site);

  // 這個人還有未結案的件 → 視為追加修改，留言到同一個 issue
  const open = await st.openRequestOf(userId);
  const openSite = open && siteById(env, open.site);
  let existing = openSite ? await st.getRequest(open.site, open.issue) : null;
  // 先向 GitHub 確認那件還開著：有人直接在 GitHub 上關掉／刪掉、或關閉事件漏接時，就當作結案、改開新件
  if (existing?.state === "open") {
    const live = await deps.gh(openSite).getIssue(existing.issue);
    if ((live.ok && live.data?.state === "closed") || live.status === 404 || live.status === 410) {
      existing.state = "closed";
      await st.putRequest(existing);
      await st.clearOpenRequest(userId, existing.site, existing.issue);
      existing = null;
    }
  }
  if (existing?.state === "open") {
    const res = await deps.gh(openSite).comment(existing.issue, `${text}\n\n— ${existing.name ?? "LINE"}（LINE 追加）`);
    if (!res.ok) return line.reply(ev.replyToken, [msg.failed()]);
    existing.round = newRound(now());
    await st.putRequest(existing);
    return line.reply(ev.replyToken, [msg.followUp(existing.issue)]);
  }

  const name = await line.displayName(userId);
  const title = text.replace(/\s+/g, " ").slice(0, 40);
  const body = `${text}\n\n---\n來自 LINE：${name ?? userId}`;
  const res = await gh.createIssue(title, body, [env.ISSUE_LABEL ?? "line-request"]);
  if (!res.ok) return line.reply(ev.replyToken, [msg.failed()]);

  const issue = res.data.number;
  await st.putRequest(newRequest({ site: site.id, issue, userId, name, now: now() }));
  await st.setOpenRequest(userId, site.id, issue);
  return line.reply(ev.replyToken, [msg.received(issue)]);
}

async function onPostback(ev, userId, env, deps) {
  const params = new URLSearchParams(ev.postback?.data ?? "");
  const action = params.get("a");
  if (action === "grant" || action === "ignore") return onReview(ev, userId, params, env, deps);
  if (action === "approve" || action === "reject") return onDecision(ev, userId, params, env, deps);
  if (action === "cancel" || action === "keep") return onCancelDecision(ev, userId, params, env, deps);
}

// 管理者審核新好友
async function onReview(ev, userId, params, env, deps) {
  const { line, st } = deps;
  if (!isAdmin(env, userId)) return line.reply(ev.replyToken, [msg.onlyAdmin()]);
  const target = params.get("u");
  const member = target && (await st.getMember(target));
  if (!member) return;

  if (params.get("a") === "ignore") {
    if (member.status !== "pending") return line.reply(ev.replyToken, [msg.alreadyDecided(member.name, member.status)]);
    member.status = "ignored";
    await st.putMember(target, member);
    return line.reply(ev.replyToken, [msg.ignored(member.name)]);
  }

  const site = siteById(env, params.get("s"));
  if (!site) return;
  if (member.status === "ignored" || member.sites.includes(site.id)) {
    return line.reply(ev.replyToken, [msg.alreadyDecided(member.name, member.status)]);
  }
  member.status = "approved";
  member.sites = [...member.sites, site.id];
  await st.putMember(target, member);
  await line.reply(ev.replyToken, [msg.granted(member.name, site)]);
  await line.push(target, [msg.guide(site)]);
}

// 提出者按［上線］／［退回］
async function onDecision(ev, userId, params, env, deps) {
  const { line, st } = deps;
  // 改版前的按鈕沒有帶網站，視為第一個網站
  const site = siteById(env, params.get("s")) ?? defaultSite(env);
  const issue = Number(params.get("n"));
  const req = issue && (await st.getRequest(site.id, issue));
  if (!req || req.state !== "open") return line.reply(ev.replyToken, [msg.alreadyDone(issue)]);
  if (userId !== req.userId) return line.reply(ev.replyToken, [msg.onlyRequester()]);
  // 之後又追加過修改的話，舊通知上的按鈕不算數（避免把改到一半的版本送上線）
  if (params.get("r") !== req.round.id || req.round.status !== "ready" || !req.round.notified) {
    return line.reply(ev.replyToken, [msg.staleButton(issue)]);
  }
  const gh = deps.gh(site);

  if (params.get("a") === "approve") {
    const res = req.pr ? await gh.mergePr(req.pr, `LINE 修改 #${issue}`) : { ok: false };
    if (!res.ok) {
      await line.reply(ev.replyToken, [msg.mergeFailed(issue)]);
      if (!isAdmin(env, userId)) await line.push(env.ADMIN_USER_ID, [msg.mergeFailedForAdmin(req, site)]);
      return;
    }
    await gh.deleteBranch(req.branch);
    req.state = "merged";
    await st.putRequest(req);
    await st.clearOpenRequest(req.userId, site.id, issue);
    // 管理者自己提的件：上線內容直接附在回覆裡（免費），不另外推播
    if (isAdmin(env, userId)) return line.reply(ev.replyToken, [msg.merged(req), msg.mergedForAdmin(req, site)]);
    await line.reply(ev.replyToken, [msg.merged(req)]);
    await line.push(env.ADMIN_USER_ID, [msg.mergedForAdmin(req, site)]);
    return;
  }

  // 退回：關 PR、關 issue、刪分支
  if (req.pr) await gh.closePr(req.pr);
  await gh.closeIssue(issue);
  await gh.deleteBranch(req.branch);
  req.state = "closed";
  await st.putRequest(req);
  await st.clearOpenRequest(req.userId, site.id, issue);
  await line.reply(ev.replyToken, [msg.rejected(req)]);
}

// 提出者確認要不要取消（Claude 判斷對方想放棄時才會出現這組按鈕）
async function onCancelDecision(ev, userId, params, env, deps) {
  const { line, st } = deps;
  const site = siteById(env, params.get("s")) ?? defaultSite(env);
  const issue = Number(params.get("n"));
  const req = issue && (await st.getRequest(site.id, issue));
  if (!req || req.state !== "open") return line.reply(ev.replyToken, [msg.alreadyDone(issue)]);
  if (userId !== req.userId) return line.reply(ev.replyToken, [msg.onlyRequester()]);
  if (params.get("r") !== req.round.id || req.round.status !== "cancel") {
    return line.reply(ev.replyToken, [msg.staleButton(issue)]);
  }

  if (params.get("a") === "keep") {
    req.round.status = "kept"; // 這組按鈕用過了；件照樣開著，下一則訊息接著改
    await st.putRequest(req);
    return line.reply(ev.replyToken, [msg.keepGoing(req)]);
  }

  // 確定取消：關 PR、關 issue、刪分支
  const gh = deps.gh(site);
  if (req.pr) await gh.closePr(req.pr);
  await gh.closeIssue(issue);
  await gh.deleteBranch(req.branch);
  req.state = "closed";
  await st.putRequest(req);
  await st.clearOpenRequest(req.userId, site.id, issue);
  await line.reply(ev.replyToken, [msg.cancelled(req)]);
}

// ── GitHub ──────────────────────────────────────────────

// workflow 在 issue 留言的第一行：<!-- line-request:status=ready;pr=12;branch=line/7;preview=https://… -->
const MARKER = /<!--\s*line-request:status=([a-z]+)((?:;[a-z]+=[^;\s>]*)*)\s*-->/;

export function parseMarker(body) {
  const m = MARKER.exec(body ?? "");
  if (!m) return null;
  const params = Object.fromEntries(
    m[2].split(";").filter(Boolean).map((kv) => kv.split("=")),
  );
  // 給人看的部分：去掉標記行，以及 ready 時附的「預覽：…」「PR：#…」兩行（Worker 會自己附預覽）
  const text = body
    .replace(MARKER, "")
    .split("\n")
    .filter((l) => !/^(PR|預覽)：/.test(l.trim()))
    .join("\n")
    .trim();
  return { status: m[1], ...params, text };
}

export { previewUrlFor };

const issueOfBranch = (branch) => {
  const m = /^line\/(\d+)$/.exec(branch ?? "");
  return m ? Number(m[1]) : null;
};

const inThisRound = (req, isoTime) => Date.parse(isoTime) >= req.round.startedAt - CLOCK_SKEW_MS;

export async function handleGithubEvent(event, payload, env, deps) {
  const { st } = deps;
  const site = siteByRepo(env, payload.repository?.full_name);
  if (!site) return; // 不是設定表裡的網站

  if (event === "issue_comment" && payload.action === "created") {
    if (payload.comment?.user?.login !== WORKFLOW_BOT) return;
    const marker = parseMarker(payload.comment.body);
    if (!marker) return;
    const req = await st.getRequest(site.id, payload.issue.number);
    if (!req || req.state !== "open" || !inThisRound(req, payload.comment.created_at)) return;
    await onWorkflowReport(req, site, marker, payload.comment.created_at, env, deps);
    await st.putRequest(req);
    return;
  }

  // 有人直接在 GitHub 上合併或關掉 PR／issue：同步狀態
  if (event === "pull_request" && payload.action === "closed") {
    const issue = issueOfBranch(payload.pull_request?.head?.ref);
    const req = issue && (await st.getRequest(site.id, issue));
    if (!req || req.state !== "open") return;
    req.state = payload.pull_request.merged ? "merged" : "closed";
    await st.putRequest(req);
    await st.clearOpenRequest(req.userId, site.id, issue);
    if (req.state === "merged") await deps.line.push(req.userId, [msg.merged(req)]);
    return;
  }
  if (event === "issues" && payload.action === "closed") {
    const req = await st.getRequest(site.id, payload.issue.number);
    if (!req || req.state !== "open") return;
    req.state = "closed";
    await st.putRequest(req);
    await st.clearOpenRequest(req.userId, site.id, req.issue);
  }
}

async function onWorkflowReport(req, site, marker, createdAt, env, deps) {
  const { line } = deps;
  const round = req.round;
  switch (marker.status) {
    case "ready":
      round.status = "ready";
      round.readyAt = Date.parse(createdAt);
      round.summary = marker.text;
      if (marker.pr) req.pr = Number(marker.pr);
      if (marker.branch) req.branch = marker.branch;
      round.previewUrl = marker.preview || previewUrlFor(site, req.branch);
      if (round.notified) return; // 同一則回報重送時不重複通知
      round.notified = true;
      await line.push(req.userId, msg.readyForRequester(req, site));
      return;
    case "cancel":
      round.status = "cancel";
      round.notified = true;
      await line.push(req.userId, msg.confirmCancel(req, site));
      return;
    case "question":
    case "nochange":
      round.status = marker.status;
      round.notified = true;
      await line.push(req.userId, [msg[marker.status](req, marker.text)]);
      return;
    default: // error
      round.status = "error";
      round.notified = true;
      if (!isAdmin(env, req.userId)) await line.push(req.userId, [msg.errorForRequester(req)]);
      await line.push(env.ADMIN_USER_ID, [msg.errorForAdmin(req, site, marker.text)]);
  }
}

// ── 排程：補做漏接的回報 ─────────────────────────────────

export async function handleScheduled(env, deps) {
  for (const req of await deps.st.listOpenRequests()) {
    try {
      await reconcile(req, env, deps);
    } catch (err) {
      console.error(`排程處理 ${req.site} #${req.issue} 失敗：${err?.stack ?? err}`);
    }
  }
}

// GitHub 的 webhook 偶爾會漏送或送失敗；超過時間還沒收到回報，就以 GitHub 上的留言為準補做。
async function reconcile(req, env, deps) {
  const r = req.round;
  if (r.notified || r.status !== "working") return;
  if (deps.now() - r.startedAt <= RECONCILE_AFTER_MS) return;
  const site = siteById(env, req.site);
  if (!site) return;

  const since = new Date(r.startedAt - CLOCK_SKEW_MS).toISOString();
  const res = await deps.gh(site).listComments(req.issue, since);
  const latest = (res.ok && Array.isArray(res.data) ? res.data : [])
    .filter((c) => c.user?.login === WORKFLOW_BOT && inThisRound(req, c.created_at))
    .map((c) => ({ marker: parseMarker(c.body), createdAt: c.created_at }))
    .filter((x) => x.marker)
    .at(-1);
  if (!latest) return; // workflow 還在跑
  await onWorkflowReport(req, site, latest.marker, latest.createdAt, env, deps);
  await deps.st.putRequest(req);
}
