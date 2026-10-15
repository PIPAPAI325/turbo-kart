// ============================================================
// AI 对手模块 —— 每辆 AI 卡丁车一个独立车手（闭包保存内部状态）
// 行为：目标点跟线 + 前瞻曲率控速 + 漂移攒迷你涡轮 +
//       近距攻防避让 + 橡皮筋 + 卡住自救 + 起步反应延迟
// 坐标约定同 track-data.js：前向 = (sin h, cos h)，h 增大 = 左转
// ============================================================
import {
  sampleAt, nearest, angleDiff,
  TOTAL_LAPS, SAMPLE_COUNT, TRACK_LENGTH,
} from './track-data.js';

/** 确定性伪随机（mulberry32）：同一种子序列恒定，保证每局同一车手风格一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 创建一个 AI 车手。
 * @param {number} kartIndex   车辆序号（决定个性参数，确定性伪随机）
 * @param {number} difficulty  0=简单 1=普通 2=困难
 * @returns {{ computeInput: Function, difficulty: number }}
 */
export function createAIDriver(kartIndex, difficulty) {
  // 种子混入 kartIndex 与总圈数：同一比赛中该车手风格恒定
  const rng = mulberry32(((kartIndex + 1) * 0x9E3779B9) ^ (TOTAL_LAPS * 7919));

  // ---------- 车手个性（每车固定） ----------
  const baseLane = (rng() * 2 - 1) * 3.2;  // 基础车道偏移 ∈ [-3.2, 3.2]
  const swayPeriod = 4 + rng() * 3;        // 车道摆动周期 4~7s
  const swayPhase = rng() * Math.PI * 2;   // 摆动初相位
  const aggression = 0.8 + rng() * 0.4;    // 激进度：影响弯速与避让强度
  const reactionDelay = rng() * 0.45;      // 起步反应延迟 0~0.45s

  // ---------- 车手内部状态 ----------
  let time = 0;            // 比赛累计时间（自车视角）
  let hintIdx = -1;        // 最近点搜索 hint，缓存在闭包里避免全量扫描
  let steerHold = 0;       // 持续大转向计时（漂移触发用）
  let driftHeld = false;   // 当前是否按住漂移
  let stuckTimer = 0;      // 近似静止持续计时
  let lastStuckAt = -1e9;  // 上次卡住触发时刻（判断 8s 内二次卡住）
  let reverseTimer = 0;    // 倒车自救剩余时间
  let lastSteer = 0;       // 上一帧转向（倒车反打用）

  /**
   * 每帧由 main.js 调用，返回物理输入。
   * @returns {{throttle:number, steer:number, drift:boolean, stuckReset:boolean}}
   */
  function computeInput(state, allStates, dt) {
    time += dt;

    // ---- 起步反应延迟：延迟期内不给输入，制造发车层次感 ----
    if (time < reactionDelay) {
      return { throttle: 0, steer: 0, drift: false, stuckReset: false };
    }

    // ---- 自车中心线投影：带 hint 的窗口搜索，index 缓存进闭包 ----
    let hint = hintIdx;
    if (hint >= SAMPLE_COUNT) hint = -1; // 防御：异常 hint 退化为全量扫描
    const near = nearest(state.x, state.z, hint);
    hintIdx = near.index;
    const myT = near.t;

    // ---- 卡住自救（优先级最高） ----
    if (reverseTimer > 0) {
      // 倒车模式：反打上一帧转向，倒够 1.1s 后恢复正常
      reverseTimer -= dt;
      const steer = clamp(-lastSteer, -1, 1);
      lastSteer = steer;
      steerHold = 0;
      driftHeld = false;
      if (reverseTimer <= 0) stuckTimer = 0;
      return { throttle: -1, steer, drift: false, stuckReset: false };
    }
    if (Math.abs(state.speed) < 2) stuckTimer += dt;
    else stuckTimer = 0;
    if (stuckTimer > 2.5) {
      if (time - lastStuckAt < 8) {
        // 8 秒内第二次卡住：请求 main 调 respawnKart，并清空计时
        stuckTimer = 0;
        lastStuckAt = -1e9;
        return { throttle: 0, steer: 0, drift: false, stuckReset: true };
      }
      // 第一次卡住：进入 1.1s 倒车模式
      lastStuckAt = time;
      reverseTimer = 1.1;
      stuckTimer = 0;
      const steer = clamp(-lastSteer, -1, 1);
      lastSteer = steer;
      steerHold = 0;
      driftHeld = false;
      return { throttle: -1, steer, drift: false, stuckReset: false };
    }

    // ---- 目标点：前瞻采样 + 个人车道偏移（固定偏移 + 慢正弦摆动） ----
    const speed = Math.max(state.speed, 0);
    const lookahead = 7 + speed * 0.38;
    const dtT = lookahead / TRACK_LENGTH;
    const s = sampleAt(myT + dtT);
    const laneOff = baseLane + Math.sin((time * Math.PI * 2) / swayPeriod + swayPhase) * 1.2;
    const tx = s.x + s.nx * laneOff;
    const tz = s.z + s.nz * laneOff;

    // ---- 基础转向：朝向目标点 ----
    const desired = Math.atan2(tx - state.x, tz - state.z);
    let steer = clamp(angleDiff(desired, state.heading) * 2.4, -1, 1);

    // ---- 纵向控制：比较前方两点切线夹角估计曲率 ----
    const tanA = sampleAt(myT + 0.010);
    const tanB = sampleAt(myT + 0.030);
    const curv = Math.abs(angleDiff(
      Math.atan2(tanA.tx, tanA.tz),
      Math.atan2(tanB.tx, tanB.tz),
    ));
    const coastT = 0.10 + difficulty * 0.03; // 收油阈值（难度高更晚收油）
    const brakeT = 0.22 + difficulty * 0.05; // 刹车阈值（难度高更晚刹车）
    let throttle;
    if (curv < coastT) throttle = 1;                    // 直道全油门
    else if (curv < brakeT) throttle = 0.55;            // 中等弯维持
    else throttle = speed > 24 ? -0.4 : 0.3;            // 急弯：快则刹，慢则带
    // curv 每帧重算，出弯曲率回落即自动恢复油门

    // ---- 攻防避让：前车近距绕行 / 被后车贴近时摆动防守 ----
    const fwdX = Math.sin(state.heading), fwdZ = Math.cos(state.heading);
    const lftX = Math.cos(state.heading), lftZ = -Math.sin(state.heading);
    let avoidSteer = 0;
    let throttleCap = 1;
    let defended = false;
    for (const other of allStates) {
      if (other === state) continue; // 不假设固定索引，直接比较引用
      const dx = other.x - state.x, dz = other.z - state.z;
      const fwd = dx * fwdX + dz * fwdZ; // 相对位置前向投影
      const lat = dx * lftX + dz * lftZ; // 横向差（左正）
      if (fwd > 1 && fwd < 9 && Math.abs(lat) < 2.4) {
        // 正前方近距：往空的一侧绕（对方在左则从右超）
        const side = lat >= 0 ? -1 : 1;
        avoidSteer += side * 0.5 * aggression;
        throttleCap = Math.min(throttleCap, fwd < 2.5 ? 0.5 : 0.8);
      } else if (fwd > -3 && fwd < -1 && Math.abs(lat) < 1.8) {
        defended = true; // 被后车贴近
      }
    }
    if (defended) avoidSteer += Math.sin(time * 3) * 0.15; // 轻微左右摆动防守
    steer = clamp(steer + avoidSteer, -1, 1);
    throttle = Math.min(throttle, throttleCap);

    // ---- 个性：油门整体乘激进度后夹紧（影响弯速与整体节奏） ----
    throttle = clamp(throttle * aggression, -1, 1);

    // ---- 橡皮筋：以玩家为参照，落后提速、领先略收（只折算进油门） ----
    const player = allStates[0] === state ? allStates[1] : allStates[0];
    if (player && player !== state) {
      const pHint = player.lastSampleIndex >= 0 ? player.lastSampleIndex : -1;
      const pT = nearest(player.x, player.z, pHint).t;
      let dT = myT - pT;
      dT -= Math.round(dT); // wrap 到 [-0.5, 0.5]
      if (dT < 0) {
        // 落后玩家：油门上限 1，并按难度给追赶加成（难度越高越弱）
        if (throttle > 0) {
          throttle = Math.min(1, throttle * (1 + 0.05 + 0.02 * (2 - difficulty)));
        }
      } else if (dT > 0.02) {
        // 领先玩家：略收油
        throttle = Math.min(throttle, 0.93);
      }
    }

    // ---- 漂移：普通/困难档，持续大转向且足够快时按住，弯中回正松开 ----
    const absSteer = Math.abs(steer);
    if (driftHeld) {
      if (absSteer < 0.3) { driftHeld = false; steerHold = 0; } // 弯结束松开
    } else if (difficulty >= 1) { // 简单档不漂移
      if (absSteer > 0.55 && speed > 20) steerHold += dt;
      else steerHold = 0;
      if (steerHold > 0.8) driftHeld = true;
    }

    lastSteer = steer;
    return { throttle, steer, drift: driftHeld, stuckReset: false };
  }

  return { computeInput, difficulty };
}
