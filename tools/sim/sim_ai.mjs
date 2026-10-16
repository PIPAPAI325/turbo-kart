// ============================================================
// 无头竞速仿真器 —— 测量“玩家极限车速”(最优参考车手) 与各难度 AI 的完赛时长。
//
// 复刻 main.js 的比赛逻辑（固定 dt=1/60、圈数 t-wrap、车车碰撞），
// 但不含渲染/音效。参考车手在仿真器内部实现（不进 src/ai.js）。
//
// 运行（项目根目录）：
//   & "...\tools\node\node-v22.14.0-win-x64\node.exe" \
//       --experimental-loader ./tools/sim/loader.mjs ./tools/sim/sim_ai.mjs
//
// 命令行参数：
//   solo      仅跑 SOLO（最优参考）计时
//   grid      仅跑 GRID（含 AI 对手）
//   <无参>     两者都跑
// ============================================================
import {
  setTrack, getStartGrid, nearest, sampleAt, angleDiff,
  TOTAL_LAPS, TRACK_COUNT, TRACKS, BOOST_PADS, nearBoostPad,
  TRACK_LENGTH,
} from '../../src/track-data.js';
import {
  createKartState, updateKartPhysics, resolveKartKartCollisions,
  respawnKart, getSample, MAX_SPEED,
} from '../../src/physics.js';
import { createAIDriver } from '../../src/ai.js';

const DT = 1 / 60;
const GRID_SLOTS = [4, 0, 1, 2, 3, 5, 6, 7];
const MAX_TIME = 600;             // 仿真时间上限 s（超过即记 DNF）
const BRAKE_DECEL = 38;           // 与 physics.js 一致，用于制动距离估算
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap01 = (t) => { t %= 1; return t < 0 ? t + 1 : t; };

// ---------------- 赛道曲率工具（rad/m，正=左转） ----------------
// TRACK_LENGTH 是 ES live binding，换图后自动反映最新长度，无需缓存。
function signedCurv(t, D) {
  const L = TRACK_LENGTH;
  const a = sampleAt(t);
  const b = sampleAt(t + D / L);
  return angleDiff(Math.atan2(b.tx, b.tz), Math.atan2(a.tx, a.tz)) / D;
}

// ---------------- 最优参考车手（玩家“极限车速”） ----------------
// 参数按赛道微调：小前瞻 + 内侧切弯 + 全加速带压线 + 遇弯必漂。每项均校验不撞墙。
const OPT_CFG = [
  { lookBase: 6.0, lookSpeed: 0.30, gain: 2.7, insideBias: 2.4, maxBias: 3.0, latAcc: 132, nearScan: 8, driftKappa: 0.020, driftHold: 0.15, scan: [8, 14, 22, 32, 45, 62] },
  { lookBase: 5.5, lookSpeed: 0.28, gain: 2.8, insideBias: 2.0, maxBias: 2.6, latAcc: 120, nearScan: 7, driftKappa: 0.024, driftHold: 0.15, scan: [7, 12, 20, 30, 42, 58] },
  { lookBase: 7.0, lookSpeed: 0.32, gain: 2.6, insideBias: 2.2, maxBias: 2.8, latAcc: 130, nearScan: 9, driftKappa: 0.018, driftHold: 0.15, scan: [9, 15, 24, 34, 48, 66] },
];

function makeOptimal(cfg) {
  let hint = -1, driftHeld = false, holdT = 0, padCount = 0;
  return {
    driver: {
      compute(s, allStates, dt) {
        const L = TRACK_LENGTH;
        const near = nearest(s.x, s.z, hint);
        hint = near.index;
        const T = near.t;

        // 前瞻曲率（用于内侧切弯与漂移触发）
        const kNear = signedCurv(T, cfg.nearScan);
        const look = cfg.lookBase + Math.abs(s.speed) * cfg.lookSpeed;
        const sA = sampleAt(T + look / L);
        let bias = clamp(Math.sign(kNear) * cfg.insideBias, -cfg.maxBias, cfg.maxBias);
        // 临近加速带：压回中心线，确保吃到加速带
        let nearPad = false;
        for (const pt of BOOST_PADS) { let d = Math.abs(T - pt); d = Math.min(d, 1 - d); if (d < 0.03) { nearPad = true; break; } }
        if (nearPad) bias *= 0.1;
        const tx = sA.x + sA.nx * bias, tz = sA.z + sA.nz * bias;
        const desired = Math.atan2(tx - s.x, tz - s.z);
        let steer = clamp(angleDiff(desired, s.heading) * cfg.gain, -1, 1);

        // 速度上限：扫描前方多个距离，按“本帧可达速度”= 制动距离修正
        let vNow = 1e9;
        for (const d of cfg.scan) {
          const k = Math.abs(signedCurv(T, d));
          const R = 1 / Math.max(k, 1e-4);
          const vCorner = Math.sqrt(cfg.latAcc * R);
          const reachable = Math.sqrt(vCorner * vCorner + 2 * BRAKE_DECEL * d);
          if (reachable < vNow) vNow = reachable;
        }
        let throttle;
        if (vNow >= MAX_SPEED) throttle = 1;
        else if (s.speed < vNow - 1.2) throttle = 1;
        else if (s.speed > vNow + 1.5) throttle = -1;
        else throttle = 0.2;

        // 漂移：弯中按住攒迷你涡轮，出弯回正后松开
        const want = Math.abs(kNear) > cfg.driftKappa && s.speed > 16;
        if (driftHeld) {
          if ((!want && Math.abs(steer) < 0.42) || Math.abs(steer) < 0.22) driftHeld = false;
        } else if (want && Math.abs(steer) > 0.42) {
          holdT += dt;
          if (holdT > cfg.driftHold) driftHeld = true;
        } else holdT = 0;

        padCount += nearBoostPad(T, near.lateral) ? 1 : 0;
        return { throttle, steer, drift: driftHeld, stuckReset: false };
      },
    },
    pads: () => padCount,
  };
}

// ---------------- 圈数推进（完全复刻 main.js updateProgress） ----------------
function updateProgress(p, state, raceTime) {
  const t = wrap01(getSample(state).t);
  let dT = t - p.lastT;
  if (dT > 0.5) dT -= 1;
  else if (dT < -0.5) {
    dT += 1;
    if (p.checkpoint) {
      p.lap++;
      p.checkpoint = false;
      if (p.lap > TOTAL_LAPS && !p.finishTime) p.finishTime = raceTime;
    }
  }
  if (t > 0.4 && t < 0.6) p.checkpoint = true;
  p.lastT = t;
}

function mkProg(state) {
  const ns = nearest(state.x, state.z, -1);
  return { lap: 0, lastT: ns.t, checkpoint: false, finishTime: 0 };
}

// ---------------- SOLO：单车测最优参考的干净配速 ----------------
function runSolo(track) {
  setTrack(track);
  const cfg = OPT_CFG[track];
  const ref = makeOptimal(cfg);
  const state = createKartState(getStartGrid(GRID_SLOTS[0]));
  const prog = mkProg(state);
  const laps = [];
  let prevLap = 0, prevLapAt = 0, raceTime = 0, wallHits = 0, maxDist = 0, prevSlide = 0;
  let boostFrames = 0, driftFrames = 0, miniTurbos = 0, prevDrift = false, lastCharge = 0;
  let sumSpeed = 0, nSpeed = 0;
  while (prog.finishTime === 0 && raceTime < MAX_TIME) {
    raceTime += DT;
    const input = ref.driver.compute(state, [state], DT);
    updateKartPhysics(state, input, DT, TOTAL_LAPS);
    updateProgress(prog, state, raceTime);
    const near = nearest(state.x, state.z, state.lastSampleIndex);
    maxDist = Math.max(maxDist, near.dist);
    if (state.wallSlide === 1 && prevSlide === 0) wallHits++;
    prevSlide = state.wallSlide;
    if (state.boostTime > 0) boostFrames++;
    if (state.drifting) driftFrames++;
    if (prevDrift && !state.drifting) { if (lastCharge > 2.4) miniTurbos += 1; else if (lastCharge > 1.2) miniTurbos += 1; }
    lastCharge = state.drifting ? state.driftCharge : 0;
    prevDrift = state.drifting;
    sumSpeed += Math.abs(state.speed); nSpeed++;
    if (prog.lap !== prevLap) { laps.push(raceTime - prevLapAt); prevLapAt = raceTime; prevLap = prog.lap; }
  }
  return {
    finishTime: prog.finishTime, laps, wallHits, maxDist, padFrames: ref.pads(),
    boostFrames, driftFrames, miniTurbos, avgSpeed: sumSpeed / nSpeed,
  };
}

// ---------------- GRID：8 车比赛（0=最优参考，1..7=真实 AI） ----------------
function runGrid(track, difficulty) {
  setTrack(track);
  const cfg = OPT_CFG[track];
  const states = [], progs = [], drivers = [];
  for (let i = 0; i < 8; i++) {
    states.push(createKartState(getStartGrid(GRID_SLOTS[i])));
    progs.push(mkProg(states[i]));
    if (i === 0) {
      const opt = makeOptimal(cfg).driver;
      drivers.push({ compute: (s, all, dt) => opt.compute(s, all, dt) });
    } else {
      const ai = createAIDriver(i, difficulty);
      drivers.push({ compute: (s, all, dt) => ai.computeInput(s, all, dt) });
    }
  }
  let raceTime = 0, done = false, wallHits = 0, stuckResets = 0;
  const prevSlide = new Array(8).fill(0);
  while (!done && raceTime < MAX_TIME) {
    raceTime += DT;
    for (let i = 0; i < 8; i++) {
      const input = drivers[i].compute(states[i], states, DT);
      if (input.stuckReset) { respawnKart(states[i]); stuckResets++; }
      updateKartPhysics(states[i], input, DT, TOTAL_LAPS);
      updateProgress(progs[i], states[i], raceTime);
      if (states[i].wallSlide === 1 && prevSlide[i] === 0) wallHits++;
      prevSlide[i] = states[i].wallSlide;
    }
    resolveKartKartCollisions(states);
    done = progs.every((p) => p.finishTime > 0);
  }
  return { progs, raceTime, wallHits, stuckResets };
}

// ---------------- 输出 ----------------
const fmt = (t) => {
  if (!t) return '  DNF   ';
  const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
};
const pct = (t, ref) => (t && ref ? (((t / ref) - 1) * 100).toFixed(1).padStart(5) + '%' : '   -  ');

const args = process.argv.slice(2);
const doSolo = !args.includes('grid');
const doGrid = !args.includes('solo');

console.log(`difficulty: 0=简单 1=普通 2=困难   总圈数=${TOTAL_LAPS}`);
const solo = [];
for (let k = 0; k < TRACK_COUNT; k++) solo.push(runSolo(k));

if (doSolo) {
  console.log('\n===== SOLO：最优参考车手（玩家极限车速），无交通 =====');
  console.log('赛道          完赛     单圈          撞墙 最大离线 平均速 涡轮秒/圈 漂移秒/圈 迷你涡轮');
  for (let k = 0; k < TRACK_COUNT; k++) {
    const r = solo[k];
    const lapStr = r.laps.slice(1).map((v) => v.toFixed(2)).join(' / ');
    const lapN = Math.max(1, r.laps.length - 1);
    console.log(
      `${TRACKS[k].name.padEnd(6)} ${fmt(r.finishTime)}  [${lapStr}]  ` +
      `撞${String(r.wallHits).padStart(2)} ${r.maxDist.toFixed(2).padStart(5)}m ` +
      `${r.avgSpeed.toFixed(1).padStart(5)} ${(r.boostFrames * DT / lapN).toFixed(2).padStart(6)} ` +
      `${(r.driftFrames * DT / lapN).toFixed(2).padStart(6)} ${String(r.miniTurbos).padStart(3)}`,
    );
  }
}

if (doGrid) {
  const only = args.find((a) => /^[0-2]$/.test(a));
  for (let k = 0; k < TRACK_COUNT; k++) {
    const ref = solo[k].finishTime;
    console.log(`\n===== GRID：[${TRACKS[k].name}]  参考(玩家极限)=${fmt(ref)} =====`);
    console.log('difficulty  0号参考   AI最快   AI中位   AI最慢   最快/参考  全车完赛 撞墙/自救');
    for (let d = 0; d < 3; d++) {
      if (only !== undefined && Number(only) !== d) continue;
      const r = runGrid(k, d);
      const times = r.progs.map((p) => p.finishTime);
      const ai = times.slice(1).filter((t) => t > 0).sort((a, b) => a - b);
      const fastest = ai[0] || 0, median = ai[Math.floor(ai.length / 2)] || 0, slowest = ai[ai.length - 1] || 0;
      console.log(
        `    ${d}      ${fmt(times[0])}  ${fmt(fastest)} ${fmt(median)} ${fmt(slowest)}  ` +
        `${pct(fastest, ref)}  ${String(ai.length).padStart(2)}/7   ${String(r.wallHits).padStart(3)}/${r.stuckResets}`,
      );
    }
  }
}
