(() => {
  'use strict';

  // 旧版私有直连没有可核验的业务回执。保留旧入口的明确拒绝，避免调用方等待或误报成功。
  class DisabledChatClient {
    async connect() { throw new Error('自动直连已停用，请在 BOSS 官方页面沟通'); }
    async sendPayload() { throw new Error('自动发送已停用，请在 BOSS 官方页面沟通'); }
    sendText() { return this.sendPayload(); }
    sendImage() { return this.sendPayload(); }
    close() {}
    isOpen() { return false; }
  }

  globalThis.BqaDirectChatClient = DisabledChatClient;
})();

