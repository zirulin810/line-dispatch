// 把 KV（成員審核、進行中的件）整份匯出成 wrangler kv bulk put 吃的格式。
// 搬 Cloudflare 帳號用：先在舊帳號登入的狀態下執行，產生 tmp/kv-backup.json。
//
//   node scripts/kv-export.mjs
//
// 匯入新帳號：npx wrangler kv bulk put tmp/kv-backup.json --binding STATE --remote

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const toml = readFileSync("wrangler.toml", "utf8");
const id = /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]+)"/.exec(toml)?.[1];
if (!id) throw new Error("wrangler.toml 裡找不到 KV id");

const run = (args) => {
  try {
    return execSync(`npx wrangler ${args} --namespace-id ${id} --remote`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch {
    // wrangler 已經把錯誤印出來了，不再印一大段堆疊
    console.error(`\n匯出失敗。先用 npx wrangler whoami 確認登入的是有這個 KV（${id}）的帳號。`);
    process.exit(1);
  }
};
const out = run("kv key list");
const keys = JSON.parse(out.slice(out.indexOf("["))).map((k) => k.name);

const data = keys.map((key) => {
  process.stdout.write(`${key}\n`);
  return { key, value: run(`kv key get "${key}" --text`).trimEnd() };
});

mkdirSync("tmp", { recursive: true });
writeFileSync("tmp/kv-backup.json", JSON.stringify(data, null, 2));
console.log(`\n匯出 ${data.length} 筆 → tmp/kv-backup.json`);
