// 網站設定表。要開放新網站時，在 wrangler.toml 的 SITES 加一筆，
// 並在那個網站的 repo 裝上 line-request workflow 與 CLAUDE.md 守則。
//
//   id            內部代號（寫進 KV 與按鈕，定了就別改）
//   name          給人看的名稱（LINE 訊息裡顯示）
//   repo          GitHub repo（owner/name）
//   pagesProject  Cloudflare Pages 專案名稱（算預覽網址用）

export function sites(env) {
  const raw = env.SITES ?? [];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export const siteById = (env, id) => sites(env).find((s) => s.id === id) ?? null;

// 舊資料（改版前開的件）沒有記錄網站，一律視為第一個網站
export const defaultSite = (env) => sites(env)[0];

export const siteByRepo = (env, fullName) =>
  sites(env).find((s) => s.repo.toLowerCase() === String(fullName ?? "").toLowerCase()) ?? null;

/** Cloudflare Pages 的分支預覽網址：分支名轉小寫、非英數換成連字號 */
export function previewUrlFor(site, branch) {
  const alias = branch.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 28).replace(/-+$/, "");
  return `https://${alias}.${site.pagesProject}.pages.dev`;
}
