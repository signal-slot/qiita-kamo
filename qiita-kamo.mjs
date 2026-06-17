#!/usr/bin/env node
// Qiita Team の記事を「ダウンロードせず」API から直接ターミナルに読むための CLI。
//   node qiita-kamo.mjs list [--page N] [--per N]   記事一覧（番号・タイトル・ID・更新日）
//   node qiita-kamo.mjs read <ID|番号>              記事1件を本文ごと表示
//   node qiita-kamo.mjs search <キーワード>          タイトル部分一致で検索
//
// 認証: ~/.config/qiita-cli/credentials.json（qiita login が生成）か 環境変数 QIITA_TOKEN。
// 接続先: .env の QIITA_DOMAIN（既定 qiita.com）。Qiita Team は <team>.qiita.com を指定。
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const readEnvDomain = async () => {
  if (process.env.QIITA_DOMAIN) return process.env.QIITA_DOMAIN;
  try {
    const txt = await readFile(path.join(process.cwd(), ".env"), "utf8");
    const m = txt.match(/^\s*QIITA_DOMAIN\s*=\s*(.+?)\s*$/m);
    if (m) return m[1];
  } catch {}
  return "qiita.com";
};

const readToken = async () => {
  if (process.env.QIITA_TOKEN) return process.env.QIITA_TOKEN;
  const file = path.join(os.homedir(), ".config", "qiita-cli", "credentials.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  const profile = data.default;
  const cred =
    data.credentials.find((c) => c.name === profile) ?? data.credentials[0];
  if (!cred) throw new Error("credentials.json にトークンがありません。`npx qiita login` を実行してください。");
  return cred.accessToken;
};

const api = async (apiPath, domain, token, { method = "GET", payload } = {}) => {
  const url = `https://${domain}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText} (${url})\n${body}`);
  }
  return res.json();
};

// 簡易 frontmatter パーサ。--- で囲まれた title/tags/private を解釈し、本文を返す。
//   ---
//   title: タイトル
//   tags: tag1, tag2
//   private: true
//   ---
//   本文...
const parseArticle = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { title: "", tags: [], private: undefined, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const tags = (meta.tags ? meta.tags.split(",") : [])
    .map((t) => t.trim())
    .filter(Boolean)
    .map((name) => ({ name, versions: [] }));
  return {
    title: meta.title ? meta.title.replace(/^['"]|['"]$/g, "") : "",
    tags,
    private: meta.private === undefined ? undefined : meta.private === "true",
    body: m[2],
  };
};

const fmtDate = (s) => (s ? String(s).slice(0, 10) : "");

const cmdList = async (domain, token, { page, per }) => {
  const items = await api(
    `/api/v2/items?page=${page}&per_page=${per}`,
    domain,
    token,
  );
  if (!items.length) {
    console.log("（記事がありません。別のページ番号を試してください）");
    return;
  }
  const base = (page - 1) * per;
  items.forEach((it, i) => {
    const n = String(base + i + 1).padStart(3, " ");
    console.log(`${n}. ${it.title}`);
    console.log(`     id=${it.id}  更新=${fmtDate(it.updated_at)}  いいね=${it.likes_count ?? 0}`);
  });
  console.log(`\n(page ${page}, ${items.length} 件表示。次ページ: node qiita-kamo.mjs list --page ${page + 1})`);
};

const cmdRead = async (domain, token, arg) => {
  let id = arg;
  // 数字なら一覧の番号として解決
  if (/^\d+$/.test(arg)) {
    const idx = Number(arg);
    const per = 100;
    const page = Math.floor((idx - 1) / per) + 1;
    const items = await api(
      `/api/v2/items?page=${page}&per_page=${per}`,
      domain,
      token,
    );
    const it = items[(idx - 1) % per];
    if (!it) throw new Error(`番号 ${idx} の記事が見つかりません。`);
    id = it.id;
  }
  const it = await api(`/api/v2/items/${id}`, domain, token);
  const tags = (it.tags || []).map((t) => t.name).join(", ");
  console.log("=".repeat(72));
  console.log(`タイトル: ${it.title}`);
  console.log(`ID      : ${it.id}`);
  console.log(`作成    : ${fmtDate(it.created_at)}   更新: ${fmtDate(it.updated_at)}`);
  if (tags) console.log(`タグ    : ${tags}`);
  if (it.url) console.log(`URL     : ${it.url}`);
  console.log("=".repeat(72));
  console.log("");
  console.log(it.body);
};

const cmdSearch = async (domain, token, keyword) => {
  const per = 100;
  let page = 1;
  let hit = 0;
  while (true) {
    const items = await api(
      `/api/v2/items?page=${page}&per_page=${per}`,
      domain,
      token,
    );
    for (const it of items) {
      if (it.title.includes(keyword)) {
        hit++;
        console.log(`${it.title}`);
        console.log(`  id=${it.id}  更新=${fmtDate(it.updated_at)}`);
      }
    }
    if (items.length < per) break;
    page++;
  }
  console.log(`\n${hit} 件ヒット。読むには: node qiita-kamo.mjs read <id>`);
};

// 全ページを走査して、述語 pred(item) が真の記事を列挙する共通処理。
const cmdFilter = async (domain, token, label, pred) => {
  const per = 100;
  let page = 1;
  let hit = 0;
  while (true) {
    const items = await api(
      `/api/v2/items?page=${page}&per_page=${per}`,
      domain,
      token,
    );
    for (const it of items) {
      if (pred(it)) {
        hit++;
        const tags = (it.tags || []).map((t) => t.name).join(", ");
        const grp = it.group ? `[${it.group.name}] ` : "";
        console.log(`${grp}${it.title}`);
        console.log(`  id=${it.id}  更新=${fmtDate(it.updated_at)}  タグ=${tags}`);
      }
    }
    if (items.length < per) break;
    page++;
  }
  console.log(`\n${label}: ${hit} 件ヒット。読むには: node qiita-kamo.mjs read <id>`);
};

const cmdTag = (domain, token, keyword) =>
  cmdFilter(domain, token, `タグ「${keyword}」`, (it) =>
    (it.tags || []).some((t) => t.name.includes(keyword)),
  );

const cmdGroup = (domain, token, keyword) =>
  cmdFilter(domain, token, `グループ「${keyword}」`, (it) =>
    it.group && (it.group.name.includes(keyword) || it.group.url_name === keyword),
  );

// 本文全文検索。一覧APIは各記事の body を含むので追加リクエストなしで横断検索できる。
// AI が社内ナレッジを参照する用途を想定し、ヒット行の抜粋を出す（全文は read で取得）。
const cmdGrep = async (domain, token, keyword) => {
  const per = 100;
  const kw = keyword.toLowerCase();
  let page = 1;
  let hit = 0;
  while (true) {
    const items = await api(
      `/api/v2/items?page=${page}&per_page=${per}`,
      domain,
      token,
    );
    for (const it of items) {
      const inTitle = it.title.toLowerCase().includes(kw);
      const lines = (it.body || "").split("\n");
      const matched = lines.filter((l) => l.toLowerCase().includes(kw));
      if (!inTitle && matched.length === 0) continue;
      hit++;
      const grp = it.group ? `[${it.group.name}] ` : "";
      console.log(`\n● ${grp}${it.title}`);
      console.log(`  id=${it.id}  著者=@${it.user?.id ?? "?"}  更新=${fmtDate(it.updated_at)}  url=${it.url}`);
      for (const l of matched.slice(0, 3)) {
        console.log(`    | ${l.trim().slice(0, 120)}`);
      }
    }
    if (items.length < per) break;
    page++;
  }
  console.log(`\n本文検索「${keyword}」: ${hit} 件ヒット。全文は: node qiita-kamo.mjs read <id>`);
};

const cmdPost = async (domain, token, file) => {
  const text = await readFile(file, "utf8");
  const a = parseArticle(text);
  if (!a.title) throw new Error("frontmatter に title: が必要です。");
  const payload = { title: a.title, body: a.body, tags: a.tags };
  if (a.private !== undefined) payload.private = a.private;
  const it = await api(`/api/v2/items`, domain, token, { method: "POST", payload });
  console.log(`投稿しました ✨`);
  console.log(`  タイトル: ${it.title}`);
  console.log(`  ID      : ${it.id}`);
  console.log(`  URL     : ${it.url}`);
};

const cmdUpdate = async (domain, token, id, file) => {
  const text = await readFile(file, "utf8");
  const a = parseArticle(text);
  const payload = { body: a.body };
  if (a.title) payload.title = a.title;
  if (a.tags.length) payload.tags = a.tags;
  if (a.private !== undefined) payload.private = a.private;
  const it = await api(`/api/v2/items/${id}`, domain, token, { method: "PATCH", payload });
  console.log(`更新しました ✨`);
  console.log(`  タイトル: ${it.title}`);
  console.log(`  ID      : ${it.id}`);
  console.log(`  URL     : ${it.url}`);
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const domain = await readEnvDomain();
  const token = await readToken();

  if (cmd === "list") {
    const page = Number(rest[rest.indexOf("--page") + 1]) || 1;
    const per = Number(rest[rest.indexOf("--per") + 1]) || 100;
    await cmdList(domain, token, { page, per });
  } else if (cmd === "read") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs read <ID|番号>");
    await cmdRead(domain, token, rest[0]);
  } else if (cmd === "search") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs search <キーワード>");
    await cmdSearch(domain, token, rest.join(" "));
  } else if (cmd === "tag") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs tag <タグ名>");
    await cmdTag(domain, token, rest.join(" "));
  } else if (cmd === "group") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs group <グループ名>");
    await cmdGroup(domain, token, rest.join(" "));
  } else if (cmd === "grep") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs grep <キーワード>");
    await cmdGrep(domain, token, rest.join(" "));
  } else if (cmd === "post") {
    if (!rest[0]) throw new Error("使い方: node qiita-kamo.mjs post <file.md>");
    await cmdPost(domain, token, rest[0]);
  } else if (cmd === "update") {
    if (!rest[0] || !rest[1]) throw new Error("使い方: node qiita-kamo.mjs update <ID> <file.md>");
    await cmdUpdate(domain, token, rest[0], rest[1]);
  } else {
    console.log(`Qiita Team 記事 読み書き CLI (接続先: ${domain})

読む:
  node qiita-kamo.mjs list [--page N] [--per N]   記事一覧
  node qiita-kamo.mjs read <ID|番号>              記事を表示（長い記事は | less 推奨）
  node qiita-kamo.mjs search <キーワード>          タイトル検索
  node qiita-kamo.mjs grep <キーワード>            本文を全文検索（抜粋表示）
書く:
  node qiita-kamo.mjs post <file.md>             新規投稿（frontmatter に title/tags/private）
  node qiita-kamo.mjs update <ID> <file.md>      既存記事を更新
`);
  }
};

main().catch((e) => {
  console.error("エラー:", e.message);
  process.exit(1);
});
