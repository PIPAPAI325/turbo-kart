// ============================================================
// 卡丁车物理模块（街机手感，纯数学实现，不依赖 three）
// 坐标/朝向约定同 track-data.js：
//   - XZ 平面，Y 轴向上；
//   - heading 角 h 的前向向量 = (sin h, cos h)，h 增大 = 左转；
//   - lateral 为带符号横向偏移（左侧为正）。
// 所有赛道几何查询均复用 track-data.js，不重复实现。
// ============================================================
import {
  WALL_HALF,
  KART_RADIUS,
  sampleAt,
  nearest,
  nearBoostPad,
  angleDiff,
} from './track-data.js';

// ---------------- 极速（显示层用 ×2.4 折算 km/h） ----------------
export const MAX_SPEED = 42;    // 普通极速 u/s
export const BOOST_SPEED = 58;  // 涡轮极速
export const REVERSE_MAX = 13;  // 倒车极速

// ---------------- 物理参数 ----------------
const ACCEL_BASE = 26;          // 油门基础加速度 u/s²
const BOOST_ACCEL = 30;         // 涡轮基础加速度 u/s²
const BRAKE_DECEL = 38;         // 刹车减速度 u/s²
const REVERSE_ACCEL = 12;       // 倒车加速度 u/s²
const DRAG_LINEAR = 6;          // 滑行阻力常数项
const DRAG_QUAD = 0.010;        // 滑行阻力速度平方项系数

const TURN_RATE = 2.3;          // 基础转向角速率 rad/s
const DRIFT_TURN_MUL = 1.45;    // 漂移期间转向角速率倍率
const DRIFT_SELF_YAW = 0.7;     // 漂移期间沿漂移方向的额外自转角速率 rad/s（反打可收）
const DRIFT_SLIP_MAX = 0.42;    // 漂移侧滑角上限 rad（运动方向相对车头的偏转）
const DRIFT_SLIP_BASE = 0.45;   // 侧滑角低速占比（越小则侧滑越随速度增长）
const DRIFT_SLIP_EASE_IN = 7;   // 入漂时侧滑角逼近目标的速率 1/s（缓动，避免瞬间甩尾）
const DRIFT_SLIP_EASE_OUT = 5.5;// 出漂时侧滑角回正的速率 1/s
const DRIFT_SCRUB = 0.09;       // 漂移擦速系数 1/s（漂移掉速代价，由迷你涡轮补偿）
const DRIFT_ENTER_STEER = 0.25; // 进入漂移所需最小 |steer|
const DRIFT_ENTER_SPEED = 16;   // 进入漂移所需最低速度 u/s
const DRIFT_EXIT_SPEED = 12;    // 低于此速度开始计时退出漂移（滞回，防抖动）
const DRIFT_EXIT_GRACE = 0.3;   // 低于退出速度后的宽限时长 s（短暂掉速不打断蓄力）
const MINI_TURBO_LV1 = 1.2;     // 一档迷你涡轮蓄力阈值 s
const MINI_TURBO_LV2 = 2.4;     // 二档蓄力阈值 s
const MINI_TURBO_LV1_T = 1.0;   // 一档涡轮时长 s
const MINI_TURBO_LV2_T = 1.8;   // 二档涡轮时长 s
const PAD_BOOST_T = 1.6;        // 加速带涡轮时长 s

const WALL_LIMIT = WALL_HALF - KART_RADIUS; // 车体中心允许的最大 |lateral|
const WALL_HIT_SLOW = 0.55;     // 撞墙瞬间速度保留比
const WALL_SLIDE_SLOW = 0.995;  // 贴墙滑行每帧速度保留比
const WALL_PUSH_YAW = 0.12;     // 撞墙时车头被推离护栏的偏转量 rad
const WALL_ALIGN_LERP = 0.25;   // 撞墙后车头对齐切线的插值系数
const TELEPORT_DIST = 30;       // 距中心线异常距离阈值，超过即复位

const KART_COLLIDE_SPEED_KEEP = 0.92;   // 车车碰撞：快车速度保留比
const KART_COLLIDE_SLOW_KEEP = 0.985;   // 车车碰撞：慢车速度保留比
const KART_COLLIDE_YAW = 0.05;          // 车车碰撞：车头偏转量 rad

// ---------------- 内部工具 ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把最近采样结果写入状态缓存（供 getSample 对外读取） */
function setSample(state, s) {
  state.sample = { index: s.index, t: s.t, lateral: s.lateral };
}

/**
 * 速度标量更新：涡轮 > 油门 > 刹车/倒车 > 滑行阻力。
 * 加速度随速度衰减：a = A * (1 - v/上限)^1.1（底数钳到 >=0 防止 NaN）。
 */
function stepSpeed(state, throttle, dt) {
  const s = state.speed;

  // 涡轮激活：向 BOOST_SPEED 加速（刹车仍可减速/倒车）
  if (state.boostTime > 0) {
    state.boostTime = Math.max(0, state.boostTime - dt);
    if (throttle < 0) {
      state.speed = s > 0
        ? Math.max(0, s - BRAKE_DECEL * dt)
        : Math.max(-REVERSE_MAX, s - REVERSE_ACCEL * dt);
    } else {
      const a = BOOST_ACCEL * Math.pow(clamp(1 - s / BOOST_SPEED, 0, 1), 1.1);
      state.speed = Math.min(BOOST_SPEED, s + a * dt);
    }
    return;
  }

  if (throttle > 0) {
    if (s > MAX_SPEED) {
      // 涡轮尾速超过普通极速：松开涡轮后靠阻力自然回落
      state.speed = Math.max(MAX_SPEED, s - (DRAG_LINEAR + DRAG_QUAD * s * s) * dt);
    } else {
      const a = ACCEL_BASE * Math.pow(clamp(1 - s / MAX_SPEED, 0, 1), 1.1);
      state.speed = Math.min(MAX_SPEED, s + a * dt);
    }
  } else if (throttle < 0) {
    // 先刹车减速到 0，再进入倒车
    state.speed = s > 0
      ? Math.max(0, s - BRAKE_DECEL * dt)
      : Math.max(-REVERSE_MAX, s - REVERSE_ACCEL * dt);
  } else {
    // 滑行阻力：只减速，不越过 0 倒退
    const drag = DRAG_LINEAR + DRAG_QUAD * s * s;
    state.speed = s > 0 ? Math.max(0, s - drag * dt)
      : s < 0 ? Math.min(0, s + drag * dt) : 0;
  }
}

/** 结束漂移并结算迷你涡轮（按蓄力时长定档） */
function endDrift(state) {
  if (state.driftCharge > MINI_TURBO_LV2) {
    state.boostTime = Math.max(state.boostTime, MINI_TURBO_LV2_T);
  } else if (state.driftCharge > MINI_TURBO_LV1) {
    state.boostTime = Math.max(state.boostTime, MINI_TURBO_LV1_T);
  }
  state.drifting = false;
  state.driftDir = 0;
  state.driftCharge = 0;
  state.driftGrace = 0;
}

/**
 * 漂移状态机：
 * 进入：按住漂移 + |steer|>0.25 + 速度>16，锁定 driftDir；
 * 期间 driftCharge 按 dt 累积，并按系数擦掉一点速度（漂移的代价）；
 * 退出：主动松键立即结算；速度低于 12 时先进入宽限窗口，
 *       持续 DRIFT_EXIT_GRACE 秒才结算（短暂掉速/蹭墙不打断蓄力）。
 */
function stepDrift(state, drift, steer, dt) {
  if (state.drifting) {
    state.driftCharge += dt;
    // 漂移擦速：按比例小幅掉速，换取迷你涡轮（有取舍才有技巧）
    if (state.speed > 0) state.speed = Math.max(0, state.speed * (1 - DRIFT_SCRUB * dt));
    // 速度滞回：短时间低于退出速度计入宽限，恢复即清零
    if (Math.abs(state.speed) < DRIFT_EXIT_SPEED) state.driftGrace += dt;
    else state.driftGrace = 0;
    if (!drift || state.driftGrace > DRIFT_EXIT_GRACE) endDrift(state);
  } else if (drift && Math.abs(steer) > DRIFT_ENTER_STEER && state.speed > DRIFT_ENTER_SPEED) {
    state.drifting = true;
    state.driftDir = Math.sign(steer);
    state.driftCharge = 0;
    state.driftGrace = 0;
  } else {
    state.driftGrace = 0;
  }
}

/**
 * 转向：yawRate = steer * 2.3 * speedFactor。
 * speedFactor 让低速转不动、高速转弯半径变大；倒车时转向反向；
 * 漂移期间角速率 ×1.45，并叠加沿 driftDir 的自转：
 * 同向打舵更收紧、反打（align<0）可收敛，避免“铁轨锁死”的手感。
 */
function stepSteer(state, steer, dt) {
  const spd = Math.abs(state.speed);
  const speedFactor = clamp(spd / 10, 0, 1) / (1 + 0.55 * spd / MAX_SPEED);
  let yawRate = steer * TURN_RATE * speedFactor;
  if (state.drifting) {
    const align = clamp(steer * state.driftDir, -1, 1); // +1 同向收紧 / -1 反打放漂
    yawRate = yawRate * DRIFT_TURN_MUL
      + state.driftDir * DRIFT_SELF_YAW * speedFactor * (0.5 + 0.5 * align);
  }
  if (state.speed < 0) yawRate = -yawRate; // 倒车转向反向
  state.heading += yawRate * dt;
}

/**
 * 位移：运动方向 = 车头 + 侧滑角。
 * 侧滑角不瞬变：目标值随速度和打舵力度变化，入漂/出漂都按速率缓动逼近，
 * 因此甩尾与回正都是渐进的；非漂移时缓慢归零，避免突兀的抓地跳变。
 */
function stepMove(state, dt) {
  let targetSlip = 0;
  if (state.drifting) {
    const spd = Math.abs(state.speed);
    const sf = clamp(spd / MAX_SPEED, 0, 1);                    // 越快侧滑越大
    const align = clamp(state.steer * state.driftDir, -1, 1);   // 同向收紧 / 反打放漂
    const steerFactor = clamp(0.55 + 0.45 * align, 0.2, 1);
    targetSlip = state.driftDir * DRIFT_SLIP_MAX
      * (DRIFT_SLIP_BASE + (1 - DRIFT_SLIP_BASE) * sf)
      * steerFactor;
  }
  const k = state.drifting ? DRIFT_SLIP_EASE_IN : DRIFT_SLIP_EASE_OUT;
  state.slip += (targetSlip - state.slip) * Math.min(1, k * dt);
  if (!state.drifting && Math.abs(state.slip) < 1e-4) state.slip = 0;

  const moveAngle = state.heading + state.slip;
  state.x += Math.sin(moveAngle) * state.speed * dt;
  state.z += Math.cos(moveAngle) * state.speed * dt;
}

/**
 * 护栏碰撞（保证任何帧率/速度下绝不穿墙）：
 * - |lateral| 超界：沿法线把位置硬性钳回边界内；
 * - 首次撞墙：掉速 ×0.55、wallHit=1、车头被推离护栏并向切线对齐；
 * - 连续贴墙滑行：只钳制位置 + 轻微减速，不重复惩罚。
 */
function handleWall(state, smp) {
  const lat = smp.lateral;
  if (Math.abs(lat) <= WALL_LIMIT) {
    state.wallSlide = 0;
    return;
  }
  const sign = lat >= 0 ? 1 : -1;
  const c = sampleAt(smp.t); // 取该处切线/法线，用于推回与对齐
  const excess = Math.abs(lat) - WALL_LIMIT;
  // 沿法线硬性钳回：任何越界都会被推回边界（含高速穿墙帧）
  state.x -= sign * c.nx * excess;
  state.z -= sign * c.nz * excess;

  if (!state.wallSlide) {
    // 撞墙瞬间
    state.speed *= WALL_HIT_SLOW;
    state.wallHit = 1;
    // 车头推离护栏（撞左墙往右推），再轻微对齐切线，避免卡死贴墙抖动
    state.heading += -sign * WALL_PUSH_YAW;
    state.heading += angleDiff(Math.atan2(c.tx, c.tz), state.heading) * WALL_ALIGN_LERP;
    state.wallSlide = 1;
  } else {
    // 连续贴墙滑行
    state.speed *= WALL_SLIDE_SLOW;
  }
}

/**
 * 车车碰撞的朝向扰动：对方在本车左侧(side>0)时车头向右偏，反之向左偏。
 * (dx,dz) 为指向对方的方向；本车左方向 = (cos h, -sin h)。
 */
function nudgeHeading(kart, dx, dz) {
  const side = dx * Math.cos(kart.heading) - dz * Math.sin(kart.heading);
  kart.heading += -Math.sign(side) * KART_COLLIDE_YAW;
}

// ============================================================
// 对外 API
// ============================================================

/**
 * 创建卡丁车状态。grid = getStartGrid(i) 的返回值 { x, z, heading, t }。
 * 额外内部字段：sample（最近采样缓存）、wallSlide（贴墙滑行标记）。
 */
export function createKartState(grid) {
  const s = nearest(grid.x, grid.z, -1);
  return {
    x: grid.x,
    z: grid.z,
    heading: grid.heading,
    speed: 0,
    steer: 0,
    throttle: 0,
    drifting: false,
    driftDir: 0,
    driftCharge: 0,
    boostTime: 0,
    lastSampleIndex: s.index,
    wallHit: 0,
    finished: false,
    // —— 内部字段 ——
    wallSlide: 0,
    slip: 0,       // 当前平滑后的侧滑角 rad（运动方向相对车头的偏转）
    driftGrace: 0, // 速度低于退出阈值后的宽限计时 s（滞回用）
    sample: { index: s.index, t: s.t, lateral: s.lateral },
  };
}

/**
 * 每帧推进一辆车的物理（dt 已由调用方 clamp 到 <=0.05，直接使用）。
 * input = { throttle: -1..1, steer: -1..1（正=左转）, drift: bool }
 * 直接修改 state，无返回值。
 */
export function updateKartPhysics(state, input, dt, totalLapsHintUnusedOk) {
  const throttle = clamp(Number(input.throttle) || 0, -1, 1);
  const steer = clamp(Number(input.steer) || 0, -1, 1);
  const drift = !!input.drift;
  state.throttle = throttle;
  state.steer = steer;

  // 更新采样缓存（用上次索引作 hint 加速搜索），异常位置直接复位
  let smp = nearest(state.x, state.z, state.lastSampleIndex);
  setSample(state, smp);
  if (!(smp.dist <= TELEPORT_DIST)) { // 条件写法同时捕获 NaN
    respawnKart(state);
    return;
  }

  stepDrift(state, drift, steer, dt);
  stepSpeed(state, throttle, dt);
  stepSteer(state, steer, dt);
  stepMove(state, dt);

  // 位移后重新采样：加速带与护栏都用最新位置判定
  smp = nearest(state.x, state.z, state.lastSampleIndex);
  setSample(state, smp);

  if (nearBoostPad(smp.t, smp.lateral)) {
    state.boostTime = Math.max(state.boostTime, PAD_BOOST_T);
  }
  handleWall(state, smp);
  // 位置被钳制后刷新采样缓存，保证 sample 与真实位置一致（AI/圈数依赖它）
  if (state.wallSlide) {
    smp = nearest(state.x, state.z, smp.index);
    setSample(state, smp);
  }

  state.lastSampleIndex = smp.index;
}

/**
 * 全部卡丁车（8 辆）两两圆形碰撞（半径 KART_RADIUS）：
 * 位置沿连线各推一半分离；快车略减速、慢车轻微扰动；车头互相推开。
 */
export function resolveKartKartCollisions(states) {
  const minD = KART_RADIUS * 2;
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;

      let d = Math.sqrt(d2);
      let nx = 1, nz = 0; // 完全重合时取任意方向
      if (d > 1e-6) {
        nx = dx / d;
        nz = dz / d;
      } else {
        d = 0;
      }

      // 位置分离：各退一半
      const push = (minD - d) * 0.5;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;

      // 快车略减速，慢车轻微扰动
      const fast = Math.abs(a.speed) >= Math.abs(b.speed) ? a : b;
      const slow = fast === a ? b : a;
      fast.speed *= KART_COLLIDE_SPEED_KEEP;
      slow.speed *= KART_COLLIDE_SLOW_KEEP;

      // 朝向轻微扰动：车头被推离对方
      nudgeHeading(a, nx, nz);
      nudgeHeading(b, -nx, -nz);
    }
  }
}

/**
 * 复位：放到最近中心线采样点上，heading 对齐切线，speed=0，
 * 清除漂移/涡轮/撞墙状态。
 */
export function respawnKart(state) {
  const near = nearest(state.x, state.z, state.lastSampleIndex);
  const t = Number.isFinite(near.t) ? near.t : 0; // 兜底：位置异常时回到起点线
  const c = sampleAt(t);
  state.x = c.x;
  state.z = c.z;
  state.heading = Math.atan2(c.tx, c.tz); // 对齐切线方向
  state.speed = 0;
  state.drifting = false;
  state.driftDir = 0;
  state.driftCharge = 0;
  state.boostTime = 0;
  state.wallHit = 0;
  state.wallSlide = 0;
  state.lastSampleIndex = c.index;
  state.sample = { index: c.index, t: c.t, lateral: 0 };
}

/** 取该状态最新的采样缓存 { index, t, lateral }，外部无需重复调用 nearest */
export function getSample(state) {
  return state.sample;
}
