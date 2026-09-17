# ADR 0012：回环受信代理与浏览器可见协议

- 状态：Accepted
- 日期：2026-09-17

## 背景

所有 POST 在进入任何 mutation 或 body 解析之前先过同源门禁（`test/security.mjs` 有矩阵守卫）：`Content-Type` 必须是 JSON，`Origin` 必须存在，且其 host 与 `Host` 头一致、其协议必须等于 socket 自身协议（`socket.encrypted ? 'https' : 'http'`），`Sec-Fetch-Site` 若出现则必须是 `same-origin`。

DSH 的 `webServer` 是纯 `node:http` 服务器（不支持 TLS），GUI 静态页与插件路由同端口、无内部转发，因此插件看到的就是浏览器原始请求。当用户经 Cloudflare Tunnel 之类的 TLS 终止代理访问时，边缘以 `https` 面向浏览器、以明文 HTTP 回源本机：浏览器发送 `Origin: https://<tunnel 域名>`，而 socket 永远是 `http`，直接比对必然失败，创建 worktree 等一切 POST 返回 403 `same-origin request required`。代理层无法补救（回源只能是明文），必须在插件侧表达「浏览器所见协议」。

同时必须承认：宿主 `webServer` 可以绑定 `0.0.0.0`，此时远端对端真实存在，任何转发头都不能被无条件信任；`X-Forwarded-For` 是客户端可追加的链，也不能作为信任判据。

## 决策

1. `sameOrigin` 先做与既往完全一致的直接比对；命中即通过，转发头不能使一个本来合法的直连请求失败。
2. 直接比对失败后进入回退路径，其前置条件是 **TCP 对端是回环地址**（解包 `::ffff:` 后为 `::1` 或 `127.0.0.0/8`）且请求至少带一个 `X-Forwarded-Proto` / `X-Forwarded-Host`。两个条件缺一不可：远端对端（`0.0.0.0` 绑定场景）与不带转发头的回环直连都维持严格 socket 校验。
3. 回退路径用 `effectiveProto = firstForwarded('x-forwarded-proto') ?? socketProtocol` 与 `effectiveHost = firstForwarded('x-forwarded-host') ?? host` 组出浏览器所见身份，再与 `Origin` 比对。转发头取首个逗号项、trim 并小写（链上第一个值才是面向客户端的那一跳）。
4. 信任判据只依赖回环身份与转发头，不引入配置项：cloudflared 与 cloudflared 语义相同的本机反代是唯一受支持形态。
5. 安全论证：`X-Forwarded-Proto` / `X-Forwarded-Host` 属 Fetch 规范 forbidden header names，网页脚本（CSRF 攻击者）无法注入；能直连回环端口的本机进程本就能够任意伪造 `Origin`，回环信任不扩大其能力。该门禁的目标始终是浏览器发起的跨站请求，而非本机进程。
6. 若代理改写 `Host`，它必须同时声明 `X-Forwarded-Host`；两者都缺失时保持拒绝，不猜测。

## 后果

- Cloudflare Tunnel（cloudflared 与本机同机、保留默认 `Host`、边缘注入 `X-Forwarded-Proto: https`）与任何「TLS 终止 + 回环回源 + 保留 Host」的反代可直接工作，无需插件配置。
- 代理若改写 `Host` 又不提供 `X-Forwarded-Host`（如 cloudflared `--http-host-header`），仍返回 403 —— 这是刻意的失败关闭，部署文档明确禁止该配置。
- cloudflared 与 DSH 不同机（对端非回环）不受支持；server 绑 `127.0.0.1` 时该形态本就不可达。
- `Sec-Fetch-Site` 语义不变：页面被跨站 iframe 嵌入时仍被拒绝。
- `sameOrigin`、`isLoopbackPeer`、`firstForwarded` 作为导出供安全矩阵直接做单元验证；HTTP 层不变，客户端半与 bundle 不需改动。
