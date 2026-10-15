// Deno Deploy 入口：直接内嵌返回整份游戏 HTML（单页游戏，任意路径均返回 index.html）
import { INDEX_HTML } from "./game.ts";

Deno.serve((_req) =>
  new Response(INDEX_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  })
);
