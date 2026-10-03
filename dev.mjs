// Local dev for the Worker, behind an egress proxy too. `wrangler dev` runs the Worker in workerd,
// which resolves hosts itself and ignores HTTPS_PROXY, so on a proxy-only network every outbound
// call fails. Here each outbound request goes through Node's fetch instead, which uses the proxy
// when NODE_USE_ENV_PROXY is set and connects directly otherwise.
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { Response, WebSocketPair } from "miniflare";
import { EnvHttpProxyAgent, WebSocket } from "undici";
import { unstable_startWorker } from "wrangler";

// workerd can't open WebSockets through the proxy either, so for those the dev server opens the
// socket itself and relays messages both ways.
async function outbound(request) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return globalThis.fetch(request.url, request);
  const headers = Object.fromEntries([...request.headers].filter(([name]) => !/^(upgrade|connection|sec-websocket-)/i.test(name)));
  const upstream = new WebSocket(request.url.replace(/^http/, "ws"), { headers, dispatcher: new EnvHttpProxyAgent() });
  upstream.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    upstream.onopen = resolve;
    upstream.onerror = () => reject(new Error(`WebSocket to ${new URL(request.url).host} failed`));
  });
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => upstream.send(event.data));
  server.addEventListener("close", () => upstream.close());
  upstream.onmessage = (event) => server.send(event.data);
  // 1005 means "no code given", which may not be sent on.
  upstream.onclose = (event) => server.close(event.code === 1005 ? 1000 : event.code, event.reason);
  return new Response(null, { status: 101, webSocket: client });
}

const copyAssets = () => execFileSync("bun", ["run", "build:assets"], { stdio: "ignore" });
copyAssets();

const worker = await unstable_startWorker({
  config: "wrangler.jsonc",
  dev: {
    server: { hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8787) },
    watch: true,
    outboundService: outbound,
  },
});
console.log(`listening on ${await worker.url}`);

// Wrangler rebuilds the Worker on code changes; the page and its files are copied into dist/ here.
watch(".", (_, file) => {
  if (file && /^(index\.html|manifest\.webmanifest|icon-\d+\.png)$/.test(file)) copyAssets();
});
