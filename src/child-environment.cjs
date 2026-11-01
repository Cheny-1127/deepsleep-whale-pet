'use strict';
// DeepSleep 的管理凭据和私有配置只留在主进程；客户端认证、PATH 与代理仍沿用启动环境。
function childEnvironment(env=process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name])=>!/^WHALE_/i.test(name)));
}
module.exports={childEnvironment};
