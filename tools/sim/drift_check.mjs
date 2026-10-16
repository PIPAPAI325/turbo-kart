// 漂移物理仿真校验：三张赛道各跑 ~40s，
// 输入 = 全油门 + 交替左右漂移，断言数值稳定（无 NaN / 不超速 / 不穿墙 / 蓄力非负）。
// 运行（项目根目录）：
//   node --experimental-loader ./tools/sim/loader.mjs ./tools/sim/drift_check.mjs
import {
  setTrack, getStartGrid, nearest, WALL_HALF, TRACK_COUNT, TRACKS,
} from '../../src/track-data.js';
import { createKartState, updateKartPhysics, BOOST_SPEED } from '../../src/physics.js';

const DT = 1 / 60;            // 固定步长，与游戏主循环一致
const DURATION = 40;          // 每张赛道仿真时长 s
const LEAD_IN = 2.0;          // 起步直线加速（先攒到漂移所需速度）
const DRIFT_TURN = 1.5;       // 单次漂移持续 s
const NEUTRAL = 0.4;          // 两次漂移之间的回正/松漂移窗口 s
const CYCLE = DRIFT_TURN + NEUTRAL;
const STEER_RATE = 5.5;       // 转向速率，与 main.js playerInput 一致
// 迷你涡轮档位（与 physics.js 的 MINI_TURBO_* 保持一致）
const LV1 = 1.2, LV2 = 2.4;
const LV1_T = 1.0, LV2_T = 1.8;

let allOk = true;

for (let k = 0; k < TRACK_COUNT; k++) {
  setTrack(k);
  const state = createKartState(getStartGrid(4));

  let t = 0;
  let steerCur = 0;
  let drifts = 0;          // 触发的漂移次数
  let boostGain = 0;       // 迷你涡轮累计秒数
  let maxSpeed = 0;
  let maxDist = 0;
  let prevDrifting = false;
  let lastCharge = 0;
  let issue = '';

  const frames = Math.round(DURATION / DT);
  for (let i = 0; i < frames && !issue; i++) {
    // ---------- 脚本输入：全油门 + 交替漂移 ----------
    let targetSteer = 0;
    let drift = false;
    if (t >= LEAD_IN) {
      const p = (t - LEAD_IN) % (2 * CYCLE);
      if (p < DRIFT_TURN) { targetSteer = 1; drift = true; }            // 左漂
      else if (p < CYCLE) { targetSteer = 0; drift = false; }           // 回正
      else if (p < CYCLE + DRIFT_TURN) { targetSteer = -1; drift = true; } // 右漂
      else { targetSteer = 0; drift = false; }                         // 回正
    }
    if (steerCur < targetSteer) steerCur = Math.min(targetSteer, steerCur + STEER_RATE * DT);
    else if (steerCur > targetSteer) steerCur = Math.max(targetSteer, steerCur - STEER_RATE * DT);

    updateKartPhysics(state, { throttle: 1, steer: steerCur, drift }, DT);
    t += DT;

    // ---------- 断言 ----------
    if (!(Number.isFinite(state.x) && Number.isFinite(state.z)
      && Number.isFinite(state.heading) && Number.isFinite(state.speed))) {
      issue = `NaN/Inf @t=${t.toFixed(2)} x=${state.x} z=${state.z} h=${state.heading} v=${state.speed}`;
      break;
    }
    if (Math.abs(state.speed) > BOOST_SPEED * 1.2) {
      issue = `超速 @t=${t.toFixed(2)} v=${state.speed.toFixed(2)}`;
      break;
    }
    const near = nearest(state.x, state.z, -1);
    if (!(near.dist <= WALL_HALF)) {
      issue = `穿墙 @t=${t.toFixed(2)} dist=${near.dist.toFixed(2)} > ${WALL_HALF}`;
      break;
    }
    if (!(state.driftCharge >= 0)) {
      issue = `蓄力为负 @t=${t.toFixed(2)} charge=${state.driftCharge}`;
      break;
    }

    // ---------- 统计 ----------
    maxSpeed = Math.max(maxSpeed, Math.abs(state.speed));
    maxDist = Math.max(maxDist, near.dist);
    if (state.drifting) {
      lastCharge = state.driftCharge;
      if (!prevDrifting) drifts++;
    } else if (prevDrifting) {
      boostGain += lastCharge > LV2 ? LV2_T : lastCharge > LV1 ? LV1_T : 0;
      lastCharge = 0;
    }
    prevDrifting = state.drifting;
  }

  const endDist = nearest(state.x, state.z, -1).dist;
  console.log(
    `[${k}] ${TRACKS[k].name.padEnd(6)} 最高速=${maxSpeed.toFixed(1).padStart(5)}u/s` +
    ` 漂移次数=${String(drifts).padStart(2)} 涡轮累计=${boostGain.toFixed(1).padStart(4)}s` +
    ` 终点离中心线=${endDist.toFixed(2)}m 最大离中线=${maxDist.toFixed(2)}m` +
    (issue ? `  ✗ ${issue}` : '  ✓'),
  );
  if (issue) allOk = false;
}

console.log(allOk ? 'ALL OK' : 'FAILED');
process.exit(allOk ? 0 : 1);
