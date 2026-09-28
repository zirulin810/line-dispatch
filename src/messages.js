// 送到 LINE 的文字都集中在這裡，要改口吻只改這份。

const text = (t) => ({ type: "text", text: t.slice(0, 5000) });

export const msg = {
  received: (issue) => text(`收到，處理中（#${issue}）。改好會再通知你，通常幾分鐘內。`),
  followUp: (issue) => text(`收到，接著改 #${issue}。`),
  textOnly: () => text("目前只看得懂文字訊息，請用文字描述要改哪裡。"),
  failed: () => text("抱歉，系統暫時出了點問題，請稍後再傳一次。"),

  // 給發訊息的人：改好了
  readyForRequester: (req) =>
    text(
      `改好了，可以先看看預覽：\n${req.round.previewUrl}\n\n${req.round.summary}\n\n` +
        "還想調整就直接回覆這裡；確認沒問題後，負責人會幫你上線。",
    ),

  // 給我：改好了＋按鈕
  readyForApprover: (req) => [
    text(
      `📝 ${req.name ?? "有人"} 的修改 #${req.issue} 改好了\n\n${req.round.summary}\n\n` +
        `預覽：${req.round.previewUrl}`,
    ),
    {
      type: "template",
      altText: `#${req.issue} 要上線嗎？`,
      template: {
        type: "buttons",
        text: `#${req.issue} 要上線嗎？`,
        actions: [
          { type: "uri", label: "看預覽", uri: req.round.previewUrl },
          {
            type: "postback",
            label: "上線",
            data: `a=approve&n=${req.issue}&r=${req.round.id}`,
            displayText: `#${req.issue} 上線`,
          },
          {
            type: "postback",
            label: "退回",
            data: `a=reject&n=${req.issue}&r=${req.round.id}`,
            displayText: `#${req.issue} 退回`,
          },
        ],
      },
    },
  ],

  // workflow 需要反問或拒絕
  question: (req, body) => text(`關於 #${req.issue}：\n\n${body}`),
  nochange: (req, body) => text(`#${req.issue}：${body}`),
  errorForRequester: (req) =>
    text(`#${req.issue} 這次沒有改成功，已經通知負責人處理。`),
  errorForApprover: (req, body) => text(`⚠️ #${req.issue} 執行失敗\n\n${body}`),

  merged: (req) => text(`#${req.issue} 已上線 🎉 網站約 1～2 分鐘後更新。`),
  rejected: (req) => text(`#${req.issue} 這次的修改沒有上線。還需要的話，直接再傳一次訊息就好。`),

  onlyApprover: () => text("只有網站負責人可以按這個按鈕。"),
  staleButton: (issue) => text(`這是 #${issue} 比較舊的預覽，請用最新一則通知的按鈕。`),
  alreadyDone: (issue) => text(`#${issue} 已經處理過了。`),
  mergeFailed: (issue) =>
    text(`#${issue} 合併失敗（可能有衝突或還在檢查中），請到 GitHub 看一下 PR。`),
};
