// LINE 派工閘道
//
//   LINE  ──訊息──▶  /line/webhook   ──開 issue／留言──▶  GitHub（網站 repo）
//   GitHub ──事件──▶  /github/webhook ──改好了＋預覽──▶     LINE（發訊息的人、我）
//   我在 LINE 按［上線］／［退回］ ──▶ 合併／關閉 PR
//
// 流程細節與部署步驟見 README.md。

import { verifyGithubSignature, verifyLineSignature } from "./crypto.js";
import { githubClient, lineClient } from "./clients.js";
import { newRequest, newRound, store } from "./store.js";
import { msg } from "./messages.js";

// GitHub 與 Cloudflare 的時鐘可能差一點，比對「這一輪之後才發生」時放寬 30 秒
const CLOCK_SKEW_MS = 30_000;
// 改好了卻一直等不到預覽完成的訊號時，最多等這麼久就先用推算的預覽網址通知
const PREVIEW_FALLBACK_MS = 4 * 60_000;
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
    gh: githubClient(env, fetchImpl),
    st: store(env.STATE),
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

const allowedUsers = (env) =>
  new Set((env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

export async function handleLineEvents(events, env, deps) {
  for (const ev of events) {
    // LINE 重送的事件已經處理過，略過以免重複開件
    if (ev.deliveryContext?.isRedelivery) continue;
    const userId = ev.source?.userId;
    if (!userId) continue;
    try {
      if (ev.type === "follow") {
        // 有人加好友：記下 userId，方便加進白名單（`npm run tail` 看得到）
        console.log(`[加好友] userId=${userId}`);
      } else if (ev.type === "message") {
        if (!allowedUsers(env).has(userId)) {
          console.log(`[未授權，略過] userId=${userId}`);
          continue;
        }
        if (ev.message?.type !== "text") {
          await deps.line.reply(ev.replyToken, [msg.textOnly()]);
          continue;
        }
        await handleText(ev, userId, env, deps);
      } else if (ev.type === "postback") {
        await handlePostback(ev, userId, env, deps);
      }
    } catch (err) {
      console.error(`處理 LINE 事件失敗：${err?.stack ?? err}`);
      if (ev.replyToken) await deps.line.reply(ev.replyToken, [msg.failed()]);
    }
  }
}

async function handleText(ev, userId, env, deps) {
  const { line, gh, st, now } = deps;
  const text = ev.message.text.trim();
  if (!text) return;

  // 這個人還有未結案的件 → 視為追加修改，留言到同一個 issue
  const openIssue = await st.openIssueOf(userId);
  const existing = openIssue ? await st.getRequest(openIssue) : null;
  // 先向 GitHub 確認那件還開著：有人直接在 GitHub 上關掉、或關閉事件漏接時，就當作結案、改開新件
  if (existing?.state === "open") {
    const live = await gh.getIssue(existing.issue);
    if (live.ok && live.data?.state === "closed") {
      existing.state = "closed";
      await st.putRequest(existing);
      await st.clearOpenIssue(userId, existing.issue);
    }
  }
  if (existing?.state === "open") {
    const res = await gh.comment(existing.issue, `${text}\n\n— ${existing.name ?? "LINE"}（LINE 追加）`);
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
  await st.putRequest(newRequest({ issue, userId, name, now: now() }));
  await st.setOpenIssue(userId, issue);
  return line.reply(ev.replyToken, [msg.received(issue)]);
}

async function handlePostback(ev, userId, env, deps) {
  const { line, gh, st } = deps;
  const params = new URLSearchParams(ev.postback?.data ?? "");
  const action = params.get("a");
  const issue = Number(params.get("n"));
  if (!["approve", "reject"].includes(action) || !issue) return;

  // 批准權：只有我
  if (userId !== env.APPROVER_USER_ID) return line.reply(ev.replyToken, [msg.onlyApprover()]);

  const req = await st.getRequest(issue);
  if (!req || req.state !== "open") return line.reply(ev.replyToken, [msg.alreadyDone(issue)]);
  // 之後又追加過修改的話，舊通知上的按鈕不算數（避免把改到一半的版本送上線）
  if (params.get("r") !== req.round.id || req.round.status !== "ready" || !req.round.notified) {
    return line.reply(ev.replyToken, [msg.staleButton(issue)]);
  }

  if (action === "approve") {
    if (!req.pr) return line.reply(ev.replyToken, [msg.mergeFailed(issue)]);
    const res = await gh.mergePr(req.pr, `LINE 修改 #${issue}`);
    if (!res.ok) return line.reply(ev.replyToken, [msg.mergeFailed(issue)]);
    await gh.deleteBranch(req.branch);
    req.state = "merged";
    await st.putRequest(req);
    await st.clearOpenIssue(req.userId, issue);
    await line.reply(ev.replyToken, [msg.merged(req)]);
    if (req.userId !== userId) await line.push(req.userId, [msg.merged(req)]);
    return;
  }

  // 退回：關 PR、關 issue、刪分支
  if (req.pr) await gh.closePr(req.pr);
  await gh.closeIssue(issue);
  await gh.deleteBranch(req.branch);
  req.state = "closed";
  await st.putRequest(req);
  await st.clearOpenIssue(req.userId, issue);
  await line.reply(ev.replyToken, [msg.rejected(req)]);
  if (req.userId !== userId) await line.push(req.userId, [msg.rejected(req)]);
}

// ── GitHub ──────────────────────────────────────────────

// workflow 在 issue 留言的第一行：<!-- line-request:status=ready;pr=12;branch=line/7 -->
const MARKER = /<!--\s*line-request:status=([a-z]+)((?:;[a-z]+=[^;\s>]*)*)\s*-->/;

export function parseMarker(body) {
  const m = MARKER.exec(body ?? "");
  if (!m) return null;
  const params = Object.fromEntries(
    m[2].split(";").filter(Boolean).map((kv) => kv.split("=")),
  );
  // 給人看的部分：去掉標記行，以及 ready 時附的「PR：#…」那行
  const text = body
    .replace(MARKER, "")
    .split("\n")
    .filter((l) => !/^PR：/.test(l.trim()))
    .join("\n")
    .trim();
  return { status: m[1], ...params, text };
}

/** Cloudflare Pages 的分支預覽網址：分支名轉小寫、非英數換成連字號 */
export function previewUrlFor(env, branch) {
  const alias = branch.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 28).replace(/-+$/, "");
  return `https://${alias}.${env.PAGES_PROJECT}.pages.dev`;
}

const issueOfBranch = (branch) => {
  const m = /^line\/(\d+)$/.exec(branch ?? "");
  return m ? Number(m[1]) : null;
};

const inThisRound = (req, isoTime) => Date.parse(isoTime) >= req.round.startedAt - CLOCK_SKEW_MS;

export async function handleGithubEvent(event, payload, env, deps) {
  const { st } = deps;

  if (event === "issue_comment" && payload.action === "created") {
    if (payload.comment?.user?.login !== WORKFLOW_BOT) return;
    const marker = parseMarker(payload.comment.body);
    if (!marker) return;
    const req = await st.getRequest(payload.issue.number);
    if (!req || req.state !== "open" || !inThisRound(req, payload.comment.created_at)) return;
    await onWorkflowReport(req, marker, payload.comment.created_at, env, deps);
    await st.putRequest(req);
    return;
  }

  // Cloudflare Pages 部署完成（它在 GitHub 上以 check run 回報）
  if (event === "check_run" && payload.action === "completed") {
    const run = payload.check_run;
    const app = `${run?.app?.slug ?? ""} ${run?.app?.name ?? ""}`.toLowerCase();
    if (!app.includes("cloudflare") || run.conclusion !== "success") return;
    const issue = issueOfBranch(run.check_suite?.head_branch);
    const req = issue && (await st.getRequest(issue));
    if (!req || req.state !== "open" || !inThisRound(req, run.completed_at)) return;
    req.round.deployedAt = Date.parse(run.completed_at);
    req.round.previewUrl = previewUrlFor(env, req.branch);
    await maybeNotifyReady(req, env, deps);
    await st.putRequest(req);
    return;
  }

  // 有人直接在 GitHub 上合併或關掉 PR／issue：同步狀態
  if (event === "pull_request" && payload.action === "closed") {
    const issue = issueOfBranch(payload.pull_request?.head?.ref);
    const req = issue && (await st.getRequest(issue));
    if (!req || req.state !== "open") return;
    req.state = payload.pull_request.merged ? "merged" : "closed";
    await st.putRequest(req);
    await st.clearOpenIssue(req.userId, issue);
    if (req.state === "merged") await deps.line.push(req.userId, [msg.merged(req)]);
    return;
  }
  if (event === "issues" && payload.action === "closed") {
    const req = await st.getRequest(payload.issue.number);
    if (!req || req.state !== "open") return;
    req.state = "closed";
    await st.putRequest(req);
    await st.clearOpenIssue(req.userId, req.issue);
  }
}

async function onWorkflowReport(req, marker, createdAt, env, deps) {
  const { line } = deps;
  const round = req.round;
  const approver = env.APPROVER_USER_ID;
  switch (marker.status) {
    case "ready":
      round.status = "ready";
      round.readyAt = Date.parse(createdAt);
      round.summary = marker.text;
      if (marker.pr) req.pr = Number(marker.pr);
      if (marker.branch) req.branch = marker.branch;
      await maybeNotifyReady(req, env, deps);
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
      if (req.userId !== approver) await line.push(req.userId, [msg.errorForRequester(req)]);
      await line.push(approver, [msg.errorForApprover(req, marker.text)]);
  }
}

// 改好（ready）＋預覽部署完成（deployed）都到了才通知；fallback 時不等預覽訊號
async function maybeNotifyReady(req, env, deps, { fallback = false } = {}) {
  const round = req.round;
  if (round.status !== "ready" || round.notified) return;
  if (!round.deployedAt && !fallback) return;
  round.previewUrl ??= previewUrlFor(env, req.branch);
  round.notified = true;
  const approver = env.APPROVER_USER_ID;
  await deps.line.push(approver, msg.readyForApprover(req));
  if (req.userId !== approver) await deps.line.push(req.userId, [msg.readyForRequester(req)]);
}

// ── 排程：補送漏接的通知 ─────────────────────────────────

export async function handleScheduled(env, deps) {
  for (const req of await deps.st.listOpenRequests()) {
    const r = req.round;
    if (r.status === "ready" && !r.notified && deps.now() - r.readyAt > PREVIEW_FALLBACK_MS) {
      await maybeNotifyReady(req, env, deps, { fallback: true });
      await deps.st.putRequest(req);
    }
  }
}
