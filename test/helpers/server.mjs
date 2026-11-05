// 测试服务器的统一启动方式。
//
// 为什么不能直接 app.listen(0)：
// macOS 上不传 host 时 Node 默认绑 [::]:P（tcp46 通配），而测试客户端走的是
// 127.0.0.1（IPv4）。端口号从 IPv6 空间借、连接却从 IPv4 空间找——当本机有别的
// 进程（比如 HTTP 代理）占着某个 IPv4 端口时，内核完全可能把同一个号码分给
// 测试服务器，而 fetch 会优先命中那个更具体的 IPv4 监听者，请求就此掉进别人
// 碗里，报 UND_ERR_SOCKET other side closed。
//
// 绑死 127.0.0.1 之后，端口分配与连接落在同一块 IPv4 空间，内核会自动避开
// 已被占用的端口，冲突从根上消失；测试服务器也不再监听所有网卡。
// 详见 Issue #64。
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * 启动一个只监听本机 IPv4 loopback 的测试服务器。
 * 返回值与 app.listen 一致（http.Server），调用方仍可自行 await 'listening'。
 */
export function listenLoopback(app, host = LOOPBACK_HOST) {
  return app.listen(0, host);
}

/** 服务器对外的基址，始终用 IPv4 loopback，与 listenLoopback 保持同一地址族。 */
export function baseUrl(server) {
  return `http://${LOOPBACK_HOST}:${server.address().port}`;
}

/** 关服务器：先掐掉 keep-alive 连接，免得 close() 等不到空闲而挂住。 */
export async function closeServer(server) {
  if (typeof server?.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
