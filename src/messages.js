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
  textOnly: () => text("目前只看得懂文字訊息，請用文字描述要改哪裡。"),
  failed: () => text("抱歉，系統暫時出了點問題，請稍後再傳一次。"),

  // 改好了：只給提出者，由他決定上線或取消
  readyForRequester: (req, site) => [
    text(
      `${site.name} #${req.issue} 改好了，可以先看看預覽：\n${req.round.previewUrl}\n\n${req.round.summary}\n\n` +
        "確認沒問題就按［上線］；還想調整就直接傳訊息告訴我。",
    ),
    msg.caseButtons(req, site, `#${req.issue} 要上線嗎？`),
  ],

  // 按鈕只有兩組：
  //   ・新的預覽（改好通知）：［看預覽］［上線］［取消這件］，出現更新的預覽前都有效
  //   ・還沒有任何修改時的反問、沒有要改的、失敗、要取消嗎：只有［取消這件］，對方回覆後就失效
  caseButtons: (req, site, prompt) => {
    // r：按鈕屬於哪一輪
    const data = (a) => `a=${a}&s=${site.id}&n=${req.issue}&r=${req.round.id}&pr=${req.pr ?? ""}`;
    return buttons(`#${req.issue} 要上線嗎？`, prompt, [
      { type: "uri", label: "看預覽", uri: req.round.previewUrl },
      postback("上線", data("approve"), `#${req.issue} 上線`),
      postback("取消這件", data("cancel"), `取消 #${req.issue}`),
    ]);
  },
  cancelOnly: (req, site, prompt = "不想繼續這件的話可以直接取消；要繼續就直接回覆我。") =>
    buttons(`要取消 #${req.issue} 嗎？`, prompt, [
      postback("取消這件", `a=cancel&s=${site.id}&n=${req.issue}&r=${req.round.id}&pr=${req.pr ?? ""}`, `取消 #${req.issue}`),
    ]),
  plain: (t) => text(t),
  askCancel: (req, site) => `要取消${site.name} #${req.issue} 嗎？要繼續的話直接回覆我就好。`,
  cancelled: (req) => text(`#${req.issue} 已取消。之後有要改的，直接傳訊息就好。`),

  // workflow 需要反問、沒有要改的、失敗
  question: (req, body) => text(`關於 #${req.issue}：\n\n${body}`),
  nochange: (req, body) => text(`#${req.issue}：${body}`),
  errorForRequester: (req) => text(`#${req.issue} 這次沒有改成功，已經通知管理員處理。`),
  errorForAdmin: (req, site, body) => text(`⚠️ ${site.name} #${req.issue} 執行失敗\n\n${body}`),

  // 上線
  merged: (req) => text(`#${req.issue} 已上線 🎉 網站約 1～2 分鐘後更新。`),
  // 給管理者：<網站> <用戶> 上線／上線內容：<變更連結>
  mergedForAdmin: (req, site) =>
    text(`${site.name} ${req.name ?? "有人"} 上線\n上線內容：https://github.com/${site.repo}/pull/${req.pr}/files`),

  onlyRequester: () => text("只有提出這件修改的人可以按這個按鈕。"),
  stillWorking: (issue) => text(`#${issue} 正在修改中，改好會再通知你。`),
  staleButton: (issue) => text(`這是 #${issue} 比較舊的按鈕，請用最新一則通知上的按鈕。`),
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
  revoked: (name) => text(`已收回 ${name ?? "對方"} 的權限，之後他傳的訊息都不會處理。`),
  alreadyIgnored: (name) => text(`${name ?? "對方"} 目前已經是忽略狀態。`),
  alreadyGranted: (name, site) => text(`${name ?? "對方"} 已經可以修改${site.name}了。`),
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
