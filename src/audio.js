// ============================================================
// 音频模块 —— 全部用 WebAudio 实时合成（引擎/漂移/涡轮/撞击/
// 倒计时/终点/背景音乐），无任何外部音频文件。
// 注意浏览器自动播放策略：必须在用户点击后调用 start()。
// ============================================================
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicTimer = null;
  }

  /** 首次用户交互时调用：创建 AudioContext 与各音源链路 */
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    } catch (e) { this.ctx = null; return; }

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // ---- 引擎声：双锯齿波 + 低通，音高随速度 ----
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineOsc1 = ctx.createOscillator();
    this.engineOsc1.type = 'sawtooth';
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.detune.value = -1215; // 低一个半八度多一点，加厚度
    this.engineOsc1.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc1.start();
    this.engineOsc2.start();

    // ---- 噪声源（漂移胎叫 / 涡轮风声共用素材） ----
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // 漂移胎叫：带通噪声
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = buf; this.skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 950; this.skidFilter.Q.value = 1.2;
    this.skidGain = ctx.createGain(); this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidFilter); this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.master);
    this.skidSrc.start();

    // ---- 背景音乐增益（可单独静音） ----
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.32;
    this.musicGain.connect(this.master);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
  }

  /** 每帧更新引擎音高/音量、漂移胎叫 */
  update(dt, { speed = 0, maxSpeed = 42, boosting = false, drifting = false, throttle = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const rev = Math.abs(speed) / maxSpeed;             // 转速比
    const base = 58 + rev * 165 + (boosting ? 34 : 0);  // 基频
    this.engineOsc1.frequency.setTargetAtTime(base, t, 0.05);
    this.engineOsc2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(500 + rev * 1600 + (throttle > 0 ? 300 : 0), t, 0.08);
    this.engineGain.gain.setTargetAtTime(0.10 + rev * 0.10 + (throttle > 0 ? 0.05 : 0), t, 0.1);
    this.skidGain.gain.setTargetAtTime(drifting && Math.abs(speed) > 8 ? 0.16 : 0, t, 0.05);
  }

  /** 通用短音（倒计时/菜单确认） */
  beep(freq = 660, dur = 0.14, type = 'square', vol = 0.25) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  playGo() { this.beep(990, 0.5, 'square', 0.3); this._sweep(300, 2400, 0.4, 0.12); }
  playBoost() { this._sweep(500, 4200, 0.5, 0.22); this.beep(1320, 0.18, 'sawtooth', 0.12); }
  playHit() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.25);
    // 叠加短噪声
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.18, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 800;
    n.connect(nf); nf.connect(ng); ng.connect(this.master);
    n.start(t); n.stop(t + 0.15);
  }
  playFinish() {
    const seq = [523, 659, 784, 1047, 784, 1047];
    seq.forEach((f, i) => setTimeout(() => this.beep(f, 0.22, 'square', 0.22), i * 130));
  }

  _sweep(f0, f1, dur, vol) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.Q.value = 1.5;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(flt); flt.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + dur + 0.05);
  }

  // ---------------- 背景音乐：132bpm 小快板芯片音 ----------------
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const ctx = this.ctx;
    const eighth = 60 / 132 / 2;
    // 音高用 MIDI 号，freq = 440 * 2^((n-69)/12)
    const f = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const lead = [69, 76, 73, 76, 69, 73, 71, 69, 64, 71, 69, 71, 66, 69, 68, 66,
                  69, 76, 78, 76, 73, 76, 73, 71, 69, 73, 76, 73, 71, 68, 64, 61];
    const bass = [45, 45, 52, 45, 40, 40, 47, 40, 42, 42, 49, 42, 38, 38, 45, 38];
    let step = 0;
    let nextTime = ctx.currentTime + 0.1;
    const schedule = () => {
      if (!this.ctx) return;
      while (nextTime < ctx.currentTime + 0.25) {
        const t = nextTime;
        // 主旋律（方波，短促）
        const ln = lead[step % lead.length];
        this._note(f(ln), t, eighth * 0.85, 'square', 0.045, this.musicGain);
        // 贝斯（三角波）
        if (step % 2 === 0) {
          const bn = bass[(step / 2) % bass.length];
          this._note(f(bn), t, eighth * 1.6, 'triangle', 0.09, this.musicGain);
        }
        // 轻 hats（每拍反拍一点噪声）
        if (step % 2 === 1) this._hat(t, 0.012);
        nextTime += eighth;
        step++;
      }
    };
    schedule();
    this.musicTimer = setInterval(schedule, 100);
  }
  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }
  _note(freq, t, dur, type, vol, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.7, dur * 0.15);
    o.connect(g); g.connect(dest || this.master);
    o.start(t); o.stop(t + dur * 1.6 + 0.05);
  }
  _hat(t, vol) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    n.playbackRate.value = 2;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f); f.connect(g); g.connect(this.musicGain);
    n.start(t); n.stop(t + 0.06);
  }
}
