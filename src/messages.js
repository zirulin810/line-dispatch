// 送到 LINE 的文字都集中在這裡，要改口吻只改這份。

const text = (t) => ({ type: "text", text: t.slice(0, 5000) });
const buttons = (altText, body, actions) => ({
  type: "template",
  altText,
  template: { type: "buttons", text: body.slice(0, 160), actions },
});
const postback = (label, data, displayText) => ({ type: "postback", label, data, displayText });

export const msg = {
  // ── 提修改 ──
  received: (issue) => text(`收到，處理中（#${issue}）。改好會再通知你，通常幾分鐘內。`),
  followUp: (issue) => text(`收到，接著改 #${issue}。`),
  textOnly: () => text("目前只看得懂文字訊息，請用文字描述要改哪裡。"),
  failed: () => text("抱歉，系統暫時出了點問題，請稍後再傳一次。"),

  // 改好了：只給提出者，由他決定上線或退回
  readyForRequester: (req, site) => {
    const data = (a) => `a=${a}&s=${site.id}&n=${req.issue}&r=${req.round.id}`;
    return [
      text(
        `${site.name} #${req.issue} 改好了，可以先看看預覽：\n${req.round.previewUrl}\n\n${req.round.summary}\n\n` +
          "確認沒問題就按［上線］；還想調整就直接傳訊息告訴我。",
      ),
      buttons(`#${req.issue} 要上線嗎？`, `#${req.issue} 要上線嗎？`, [
        { type: "uri", label: "看預覽", uri: req.round.previewUrl },
        postback("上線", data("approve"), `#${req.issue} 上線`),
        postback("退回", data("reject"), `#${req.issue} 退回`),
      ]),
    ];
  },

  // Claude 判斷對方要放棄這件：先確認
  confirmCancel: (req, site) => {
    const data = (a) => `a=${a}&s=${site.id}&n=${req.issue}&r=${req.round.id}`;
    return [
      buttons(`要取消 #${req.issue} 嗎？`, `要取消${site.name} #${req.issue} 嗎？`, [
        postback("確定取消", data("cancel"), `確定取消 #${req.issue}`),
        postback("繼續修改", data("keep"), "繼續修改"),
      ]),
    ];
  },
  cancelled: (req) => text(`#${req.issue} 已取消。之後有要改的，直接傳訊息就好。`),
  keepGoing: (req) => text(`好的，#${req.issue} 繼續進行，可以繼續告訴我要改什麼。`),

  // workflow 需要反問、沒有要改的、失敗
  question: (req, body) => text(`關於 #${req.issue}：\n\n${body}`),
  nochange: (req, body) => text(`#${req.issue}：${body}`),
  errorForRequester: (req) => text(`#${req.issue} 這次沒有改成功，已經通知管理員處理。`),
  errorForAdmin: (req, site, body) => text(`⚠️ ${site.name} #${req.issue} 執行失敗\n\n${body}`),

  // 上線／退回
  merged: (req) => text(`#${req.issue} 已上線 🎉 網站約 1～2 分鐘後更新。`),
  rejected: (req) => text(`#${req.issue} 這次的修改沒有上線。還需要的話，直接再傳一次訊息就好。`),
  // 給管理者：<網站> <用戶> 上線／上線內容：<變更連結>
  mergedForAdmin: (req, site) =>
    text(`${site.name} ${req.name ?? "有人"} 上線\n上線內容：https://github.com/${site.repo}/pull/${req.pr}/files`),

  onlyRequester: () => text("只有提出這件修改的人可以按這個按鈕。"),
  staleButton: (issue) => text(`這是 #${issue} 比較舊的預覽，請用最新一則通知的按鈕。`),
  alreadyDone: (issue) => text(`#${issue} 已經處理過了。`),
  mergeFailed: (issue) => text(`#${issue} 上線失敗（可能有衝突或還在檢查中），已經通知管理員。`),
  mergeFailedForAdmin: (req, site) =>
    text(`⚠️ ${site.name} #${req.issue} 合併失敗，請看 PR：https://github.com/${site.repo}/pull/${req.pr}`),

  // ── 好友審核 ──
  waitingApproval: () => text("你好！已經通知管理員，開放使用後會再通知你。"),
  approvalRequest: (userId, name, siteList) => [
    text(`新好友：${name ?? "（查不到名字）"}\n要開放哪個網站給他改？`),
    buttons(`新好友：${name ?? ""}`, `開放給 ${name ?? "這位"}：`, [
      ...siteList.slice(0, 3).map((s) => postback(s.name, `a=grant&u=${userId}&s=${s.id}`, `開放${s.name}`)),
      postback("忽略", `a=ignore&u=${userId}`, "忽略"),
    ]),
  ],
  granted: (name, site) => text(`已開放 ${name ?? "對方"} 修改${site.name}。`),
  ignored: (name) => text(`已忽略 ${name ?? "對方"}，之後他傳的訊息都不會處理。`),
  alreadyDecided: (name, status) =>
    text(`${name ?? "對方"} 已經${status === "ignored" ? "被忽略" : "開放"}過了。`),
  onlyAdmin: () => text("只有管理員可以按這個按鈕。"),
  guide: (site) =>
    text(
      `你已經可以用 LINE 修改${site.name}了 🎉\n\n` +
        "直接傳訊息告訴我要改哪裡，例如：\n「首頁的營業時間改成週一到週六 9:00–18:00」\n\n" +
        "改好後我會傳預覽給你，確認沒問題按［上線］就會更新到網站。\n\n" +
        "・可以改：文字、顏色、排版、聯絡資訊\n" +
        "・商品資料請用商品管理後台\n" +
        "・改到一半還想調整，直接再傳訊息就會接著改",
    ),
};
