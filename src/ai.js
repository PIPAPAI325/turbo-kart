// ============================================================
// AI 对手模块 —— 每辆 AI 卡丁车一个独立车手（闭包保存内部状态）
// 行为：赛道中心线跟线 + 前瞻曲率控速（制动距离修正）+ 弯中漂移 +
//       加速带压线 + 近距攻防避让 + 难度分档 + 橡皮筋(高难度大幅削弱) +
//       卡住自救 + 起步反应延迟
//
// 难度分档通过 PROFILES 表实现：弯速系数(latAcc)、前瞻、漂移意愿、
// 加速带瞄准(padSeek)、个人巡航上限(paceCap)、橡皮筋强度(rubber)
// 随难度单调增强，因此 简单 < 普通 < 困难，且困难档配速逼近“玩家极限车速”。
//
// 坐标约定同 track-data.js：前向 = (sin h, cos h)，h 增大 = 左转
// 本模块只依赖 track-data.js。
// ============================================================
import {
  sampleAt, nearest, angleDiff,
  TOTAL_LAPS, SAMPLE_COUNT, TRACK_LENGTH, BOOST_PADS,
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

// 与 physics.js 保持一致的常量（禁止导入 physics.js，故此处镜像数值）
const MAX_SPEED = 42;      // 普通极速 u/s
const BOOST_SPEED = 58;    // 涡轮极速 u/s
const BRAKE_DECEL = 38;    // 刹车减速度 u/s²（用于制动距离估算）

// 前瞻曲率扫描距离（米）：越近的采样越能决定入弯速度
const SCAN_DIST = [8, 14, 22, 32, 46, 62];

// ---------------- 难度档案（0=简单 1=普通 2=困难） ----------------
// 弯速系数 latAcc：弯中可达速度 v=√(latAcc·R)，越大弯速越高。
// paceCap：个人巡航上限（×MAX_SPEED）。直道无弯时若超过此上限即收油，
//          产生“不会一直满油门”的保守配速；涡轮加速期间不受其限制。
// padSeek：加速带压线强度（0=不瞄准可能漏吃，1=紧贴中心线必吃）。
// rubber：落后/领先的橡皮筋强度（高难度调低，让配速反映真实实力）。
// 三个难度用同一套控制器，仅系数量级不同 → 配速单调 简单<普通<困难。
const PROFILES = [
  { // 0 简单
    latAcc: 64, lookBase: 10.0, lookSpeed: 0.44, gain: 2.15, nearScan: 12,
    insideBias: 0.6, maxBias: 1.8, laneScale: 1.0, wobble: 1.0,
    driftKappa: 0.032, driftHold: 0.50, driftMinSteer: 0.62,
    padSeek: 0.0, paceCap: 0.828, rubber: 1.0,
  },
  { // 1 普通
    latAcc: 82, lookBase: 8.2, lookSpeed: 0.37, gain: 2.30, nearScan: 10,
    insideBias: 1.1, maxBias: 2.1, laneScale: 0.7, wobble: 0.7,
    driftKappa: 0.024, driftHold: 0.30, driftMinSteer: 0.50,
    padSeek: 0.4, paceCap: 0.888, rubber: 0.55,
  },
  { // 2 困难
    latAcc: 95, lookBase: 7.4, lookSpeed: 0.34, gain: 2.4, nearScan: 9,
    insideBias: 1.4, maxBias: 2.5, laneScale: 0.5, wobble: 0.55,
    driftKappa: 0.020, driftHold: 0.20, driftMinSteer: 0.44,
    padSeek: 0.7, paceCap: 0.925, rubber: 0.0,
  },
];

/**
 * 创建一个 AI 车手。
 * @param {number} kartIndex   车辆序号（决定个性参数，确定性伪随机）
 * @param {number} difficulty  0=简单 1=普通 2=困难
 * @returns {{ computeInput: Function, difficulty: number }}
 */
export function createAIDriver(kartIndex, difficulty) {
  // 种子混入 kartIndex 与总圈数：同一比赛中该车手风格恒定
  const rng = mulberry32(((kartIndex + 1) * 0x9E3779B9) ^ (TOTAL_LAPS * 7919));
  const d = clamp(Math.round(difficulty) || 0, 0, 2);
  const P = PROFILES[d];

  // ---------- 车手个性（每车固定） ----------
  const baseLane = (rng() * 2 - 1) * 3.2;  // 基础车道偏移 ∈ [-3.2, 3.2]
  const swayPeriod = 4 + rng() * 3;        // 车道摆动周期 4~7s
  const swayPhase = rng() * Math.PI * 2;   // 摆动初相位
  const aggression = 0.94 + rng() * 0.12;  // 弯速个性系数 ∈ [0.94,1.06]（收紧差距）
  const reactionDelay = rng() * (0.45 - 0.12 * d); // 起步反应延迟（高难度更小）
  const latAcc = P.latAcc * aggression;    // 个性 × 难度的实际弯速系数

  // ---------- 车手内部状态 ----------
  let time = 0;            // 比赛累计时间（自车视角）
  let hintIdx = -1;        // 最近点搜索 hint，缓存在闭包里避免全量扫描
  let steerHold = 0;       // 持续大转向计时（漂移触发用）
  let driftHeld = false;   // 当前是否按住漂移
  let stuckTimer = 0;      // 近似静止持续计时
  let lastStuckAt = -1e9;  // 上次卡住触发时刻（判断 8s 内二次卡住）
  let reverseTimer = 0;    // 倒车自救剩余时间
  let lastSteer = 0;       // 上一帧转向（倒车反打用）

  /** 计算 t 处沿赛道走 D 米后的带符号曲率（rad/m，正=左转） */
  function curvOf(t, D) {
    const a = sampleAt(t);
    const b = sampleAt(t + D / TRACK_LENGTH);
    return angleDiff(Math.atan2(b.tx, b.tz), Math.atan2(a.tx, a.tz)) / D;
  }

  /** 前方加速带接近度：返回 [0,1]，1=正贴合加速带（用于压回中心线） */
  function padAheadFactor(myT) {
    if (P.padSeek <= 0) return 0;
    let best = 0;
    for (const pt of BOOST_PADS) {
      let dT = pt - myT;
      dT -= Math.round(dT);              // wrap 到 [-0.5, 0.5]
      const aheadM = dT * TRACK_LENGTH;  // 带符号：>0 在前方
      if (aheadM > -4 && aheadM < 16) {
        // 越接近加速带，压线强度越高
        best = Math.max(best, 1 - Math.abs(aheadM - 6) / 10);
      }
    }
    return clamp(best, 0, 1) * P.padSeek;
  }

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

    // ---- 目标点：前瞻采样 + 车道偏移 + 内侧切弯 + 加速带压线 ----
    const speed = Math.max(state.speed, 0);
    const look = P.lookBase + speed * P.lookSpeed;
    const s = sampleAt(myT + look / TRACK_LENGTH);
    const kNear = curvOf(myT, P.nearScan);            // 近处弯曲方向（决定切内侧）
    const sway = Math.sin((time * Math.PI * 2) / swayPeriod + swayPhase) * 1.2 * P.wobble;
    const padF = padAheadFactor(myT);                 // 加速带压线强度 [0,1]
    const laneOff = (baseLane * P.laneScale + sway) * (1 - padF);
    const insideBias = clamp(Math.sign(kNear) * P.insideBias, -P.maxBias, P.maxBias) * (1 - padF);
    const lat = laneOff + insideBias;
    const tx = s.x + s.nx * lat;
    const tz = s.z + s.nz * lat;

    // ---- 基础转向：朝向目标点 ----
    const desired = Math.atan2(tx - state.x, tz - state.z);
    let steer = clamp(angleDiff(desired, state.heading) * P.gain, -1, 1);

    // ---- 纵向控制：扫描前方曲率，按制动距离修正得到“本帧可达速度” ----
    let cornerV = Infinity;
    for (const dist of SCAN_DIST) {
      const k = Math.abs(curvOf(myT, dist));
      const R = 1 / Math.max(k, 1e-4);                // 弯道半径
      const vCorner = Math.sqrt(latAcc * R);          // 该弯可持续速度
      const reach = Math.sqrt(vCorner * vCorner + 2 * BRAKE_DECEL * dist); // 现可安全达到
      if (reach < cornerV) cornerV = reach;
    }
    // 无更紧弯道约束时，受个人巡航上限约束（不会一直满油门 → 保守配速）
    const cruise = MAX_SPEED * P.paceCap;
    const capped = cornerV > cruise;
    const lim = capped ? cruise : cornerV;
    let throttle;
    if (speed < lim - 1.2) throttle = 1;
    else if (speed > lim + 1.5) throttle = capped ? 0 : -1; // 巡航超限只收油，弯道超限才刹车
    else throttle = capped ? 1 : 0.25;

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
      const lateral = dx * lftX + dz * lftZ; // 横向差（左正）
      if (fwd > 1 && fwd < 9 && Math.abs(lateral) < 2.4) {
        // 正前方近距：往空的一侧绕（对方在左则从右超）
        const side = lateral >= 0 ? -1 : 1;
        avoidSteer += side * 0.5 * aggression;
        throttleCap = Math.min(throttleCap, fwd < 2.5 ? 0.6 : 0.85);
      } else if (fwd > -3 && fwd < -1 && Math.abs(lateral) < 1.8) {
        defended = true; // 被后车贴近
      }
    }
    if (defended) avoidSteer += Math.sin(time * 3) * 0.15 * P.wobble; // 轻微左右摆动防守
    // 加速带压线期间优先保证线路，削弱避让打舵
    steer = clamp(steer + avoidSteer * (1 - 0.5 * padF), -1, 1);
    throttle = Math.min(throttle, throttleCap);

    // ---- 橡皮筋：以玩家为参照，落后提速/领先略收（高难度大幅削弱） ----
    const player = allStates[0] === state ? allStates[1] : allStates[0];
    if (player && player !== state && P.rubber > 0) {
      const pHint = player.lastSampleIndex >= 0 ? player.lastSampleIndex : -1;
      const pT = nearest(player.x, player.z, pHint).t;
      let dT = myT - pT;
      dT -= Math.round(dT); // wrap 到 [-0.5, 0.5]
      if (dT < 0) {
        // 落后玩家：油门按难度给追赶加成
        if (throttle > 0) throttle = Math.min(1, throttle * (1 + 0.09 * P.rubber));
      } else if (dT > 0.02 && P.rubber > 0.5) {
        // 领先玩家（仅低难度）：略收油
        throttle = Math.min(throttle, 0.93);
      }
    }

    // ---- 漂移：弯中按住攒迷你涡轮，出弯回正后松开 ----
    const absSteer = Math.abs(steer);
    const wantDrift = Math.abs(kNear) > P.driftKappa && speed > 16;
    if (driftHeld) {
      // 弯结束且已回正 / 打舵过小 → 松开并结算迷你涡轮
      if ((!wantDrift && absSteer < P.driftMinSteer) || absSteer < 0.22) {
        driftHeld = false;
        steerHold = 0;
      }
    } else if (wantDrift && absSteer > P.driftMinSteer) {
      steerHold += dt;
      if (steerHold > P.driftHold) driftHeld = true;
    } else {
      steerHold = 0;
    }

    lastSteer = steer;
    return { throttle, steer, drift: driftHeld, stuckReset: false };
  }

  return { computeInput, difficulty: d };
}
