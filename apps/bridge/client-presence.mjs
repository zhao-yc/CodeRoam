/** 中转在线人数只控制后台采集强度；不触碰手机订阅、审批或消息写入。 */
export class ClientPresenceController {
  constructor({ onModeChange = () => {}, graceMs = 300000, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
    this.onModeChange = onModeChange;
    this.graceMs = graceMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.mode = 'legacy';
    this.onlineCount = null;
    this.revision = -1;
    this.supported = false;
    this.connected = false;
    this.closed = false;
    this.timer = null;
  }

  /** 每次连接 welcome 都重新确认能力；旧中转绝不能被推断为无人在线。 */
  configure({ supported, generation, hostId }) {
    if (this.closed) return;
    const changed = this.hostId !== hostId || this.generation !== generation;
    this.hostId = hostId;
    this.generation = generation;
    this.supported = supported === true;
    this.connected = true;
    this.revision = -1;
    if (!this.supported || changed) {
      this.stopTimer();
      this.onlineCount = null;
      this.setMode('legacy');
    }
  }

  /** 只接受当前实例、当前连接收到的单调快照，旧代次和重复帧均无副作用。 */
  update(message) {
    if (this.closed || !this.connected || !this.supported || message?.v !== 1 || message.type !== 'clients.presence' || message.hostId !== this.hostId || message.generation !== this.generation || !Number.isSafeInteger(message.revision) || message.revision < 0 || message.revision <= this.revision || !Number.isSafeInteger(message.onlineCount) || message.onlineCount < 0) return false;
    this.revision = message.revision;
    this.onlineCount = message.onlineCount;
    if (message.onlineCount > 0) {
      this.stopTimer();
      this.setMode('online');
    } else this.startGrace();
    return true;
  }

  /** 支持新协议的连接断开时启动同一宽限期，重连与零人数快照不重复延长。 */
  disconnected() {
    this.connected = false;
    if (this.closed || !this.supported) return;
    this.onlineCount = null;
    this.startGrace();
  }

  startGrace() {
    if (this.timer !== null || this.mode === 'light') return;
    this.setMode('grace');
    this.timer = this.schedule(() => {
      this.timer = null;
      if (!this.closed && this.supported) this.setMode('light');
    }, this.graceMs);
    this.timer?.unref?.();
  }

  stopTimer() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onModeChange(mode);
  }

  /** 停止后丢弃后续连接和定时回调，避免实例关闭后重新切换采集模式。 */
  close() {
    this.closed = true;
    this.connected = false;
    this.stopTimer();
  }
}
