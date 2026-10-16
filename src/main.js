// ============================================================
// 主游戏逻辑 —— 渲染/相机/HUD/圈数排名/输入/游戏状态机
// 模块分工：physics.js(物理) environment.js(场景) ai.js(对手)
//           audio.js(音效) track-data.js(共享赛道数据)
// ============================================================
import * as THREE from 'three';
import {
  ROSTER, TOTAL_LAPS, TRACK_POINTS, TRACKS, sampleAt, nearest, getStartGrid,
  setTrack, TRACK_LENGTH,
} from './track-data.js';
import {
  createKartState, updateKartPhysics, resolveKartKartCollisions,
  respawnKart, getSample, BOOST_SPEED,
} from './physics.js';
import { createAIDriver } from './ai.js';
import { createWorld, createKartMesh } from './environment.js';
import { GameAudio } from './audio.js';

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const el = {
  loading: $('loading'), menu: $('menu'), colorRow: $('colorRow'), diffRow: $('diffRow'),
  trackRow: $('trackRow'),
  startBtn: $('startBtn'), hud: $('hud'), posVal: $('posVal'), posSuffix: $('posSuffix'),
  lapVal: $('lapVal'), timeVal: $('timeVal'), bestLapVal: $('bestLapVal'),
  speedVal: $('speedVal'), boostFill: $('boostFill'), minimap: $('minimap'),
  wrongway: $('wrongway'), driftTip: $('driftTip'), countdown: $('countdown'),
  results: $('results'), resultRows: $('resultRows'), againBtn: $('againBtn'),
  pause: $('pause'), resumeBtn: $('resumeBtn'), restartBtn: $('restartBtn'),
  touch: $('touch'), soundBtn: $('soundBtn'), err: $('err'),
};

window.onerror = (msg, src, line) => {
  el.err.style.display = 'block';
  el.err.textContent += `[错误] ${msg}\n${src}:${line}\n`;
};

// ---------------- 渲染器 / 场景 / 相机 ----------------
const renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4000);
const world = createWorld(scene, renderer);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------- 全局状态 ----------------
const audio = new GameAudio();
let mode = 'menu';          // menu | countdown | race | finished
let paused = false;
let difficulty = 1;
let trackIndex = 0;
let playerColorIdx = 0;
let raceTime = 0;
let countTimer = 0;
let countShown = -1;
let finishShowTimer = -1;
let menuAngle = 0;

const karts = [];           // { idx, name, color, isPlayer, state, mesh, wheels, frontPivots, body,
                            //   driver, lap, lastT, checkpoint, lapStart, bestLap, finishTime, wheelSpin }
const statesArr = [];       // 传给 AI / 碰撞的纯状态数组（玩家固定 index 0）

// ---------------- 输入 ----------------
const keys = new Set();
const touch = { left: false, right: false, gas: false, brake: false, drift: false };
let steerCur = 0;

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Escape') togglePause();
  if (e.code === 'KeyR' && mode === 'race' && !paused) {
    respawnKart(karts[0].state);
    karts[0].wrongTimer = 0;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

function bindTouch(id, prop) {
  const b = $(id);
  const on = (e) => { e.preventDefault(); touch[prop] = true; b.classList.add('on'); };
  const off = (e) => { e.preventDefault(); touch[prop] = false; b.classList.remove('on'); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('pointercancel', off);
}
bindTouch('tLeft', 'left'); bindTouch('tRight', 'right');
bindTouch('tGas', 'gas'); bindTouch('tBrake', 'brake'); bindTouch('tDrift', 'drift');
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) el.touch.classList.remove('hidden');

function playerInput(dt) {
  const up = keys.has('KeyW') || keys.has('ArrowUp') || touch.gas;
  const down = keys.has('KeyS') || keys.has('ArrowDown') || touch.brake;
  const left = keys.has('KeyA') || keys.has('ArrowLeft') || touch.left;
  const right = keys.has('KeyD') || keys.has('ArrowRight') || touch.right;
  const drift = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.drift;

  const target = (left ? 1 : 0) - (right ? 1 : 0);
  const rate = target !== 0 ? 5.5 : 7.5;
  if (steerCur < target) steerCur = Math.min(target, steerCur + rate * dt);
  else if (steerCur > target) steerCur = Math.max(target, steerCur - rate * dt);

  return { throttle: up ? 1 : down ? -1 : 0, steer: steerCur, drift };
}

// ---------------- 菜单 ----------------
ROSTER.forEach((r, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' sel' : '');
  b.style.background = '#' + r.color.toString(16).padStart(6, '0');
  b.title = r.name;
  b.onclick = () => {
    playerColorIdx = i;
    el.colorRow.querySelectorAll('.swatch').forEach((s, j) => s.classList.toggle('sel', j === i));
    audio.start(); audio.beep(880, 0.08, 'square', 0.15);
  };
  el.colorRow.appendChild(b);
});
el.diffRow.querySelectorAll('.diff-btn').forEach((b) => {
  b.onclick = () => {
    difficulty = Number(b.dataset.d);
    el.diffRow.querySelectorAll('.diff-btn').forEach((x) => x.classList.toggle('sel', x === b));
    audio.start(); audio.beep(880, 0.08, 'square', 0.15);
  };
});
// 地图选择（沿用难度按钮样式）；切换即时重建场景与缩略图
TRACKS.forEach((t, i) => {
  const b = document.createElement('button');
  b.className = 'diff-btn' + (i === 0 ? ' sel' : '');
  b.textContent = t.name;
  b.onclick = () => {
    trackIndex = i;
    el.trackRow.querySelectorAll('.diff-btn').forEach((x, j) => x.classList.toggle('sel', j === i));
    setTrack(trackIndex);
    world.rebuildTrack();
    rebuildMinimap();
    audio.start(); audio.beep(880, 0.08, 'square', 0.15);
  };
  el.trackRow.appendChild(b);
});
el.startBtn.onclick = () => { audio.start(); audio.beep(660, 0.1); startRace(); };
el.againBtn.onclick = () => { el.results.classList.add('hidden'); startRace(); };
el.restartBtn.onclick = () => { el.pause.classList.add('hidden'); paused = false; startRace(); };
el.resumeBtn.onclick = () => togglePause();
el.soundBtn.onclick = () => {
  audio.start();
  audio.setMuted(!audio.muted);
  el.soundBtn.textContent = audio.muted ? '声音: 关' : '声音: 开';
};

function togglePause() {
  if (mode !== 'race' && mode !== 'countdown') return;
  paused = !paused;
  el.pause.classList.toggle('hidden', !paused);
  if (audio.ctx) { paused ? audio.ctx.suspend() : audio.ctx.resume(); }
}

// ---------------- 创建/重置比赛 ----------------
function buildKarts() {
  if (karts.length) return;
  const order = [playerColorIdx, ...ROSTER.map((_, i) => i).filter((i) => i !== playerColorIdx)];
  const gridSlots = [4, 0, 1, 2, 3, 5, 6, 7]; // 玩家第 5 位发车，超车更有乐趣
  order.forEach((rosterIdx, arrIdx) => {
    const r = ROSTER[rosterIdx];
    const state = createKartState(getStartGrid(gridSlots[arrIdx]));
    const mesh = createKartMesh(r.color);
    scene.add(mesh);
    const kart = {
      arrIdx, name: r.name, color: r.color, isPlayer: arrIdx === 0,
      state, mesh,
      wheels: mesh.userData.wheels, frontPivots: mesh.userData.frontPivots,
      body: mesh.userData.body, driver: null,
      lap: 0, lastT: getSample(state).t, checkpoint: false,
      lapStart: 0, bestLap: 0, finishTime: 0, wheelSpin: 0,
      wrongTimer: 0, boostFlash: 0,
    };
    if (arrIdx > 0) kart.driver = createAIDriver(arrIdx, difficulty);
    karts.push(kart);
    statesArr.push(state);
  });
}

function resetRaceState() {
  const gridSlots = [4, 0, 1, 2, 3, 5, 6, 7];
  karts.forEach((k, arrIdx) => {
    const g = getStartGrid(gridSlots[arrIdx]);
    const s = k.state;
    const ns = nearest(g.x, g.z, -1);
    s.x = g.x; s.z = g.z; s.heading = g.heading;
    s.speed = 0; s.steer = 0; s.throttle = 0;
    s.drifting = false; s.driftDir = 0; s.driftCharge = 0;
    s.boostTime = 0; s.wallHit = 0; s.wallSlide = 0; s.finished = false;
    s.lastSampleIndex = ns.index;
    s.sample = { index: ns.index, t: ns.t, lateral: ns.lateral };
    k.lap = 0; k.lastT = ns.t; k.checkpoint = false;
    k.lapStart = 0; k.bestLap = 0; k.finishTime = 0;
    k.wrongTimer = 0; k.boostFlash = 0; k.wheelSpin = 0;
  });
  raceTime = 0; steerCur = 0;
}

function startRace() {
  // 应用所选地图：必须在排位 (getStartGrid) 计算之前完成
  setTrack(trackIndex);
  world.rebuildTrack();
  rebuildMinimap();
  buildKarts();
  // AI 车手每局重建（内部计时器/难度归零）
  karts.forEach((k, i) => { if (i > 0) k.driver = createAIDriver(i, difficulty); });
  resetRaceState();
  el.menu.classList.add('hidden');
  el.results.classList.add('hidden');
  el.hud.classList.remove('hidden');
  mode = 'countdown'; countTimer = 0; countShown = -1;
  snapChaseCam();
}

// ---------------- 圈数 / 排名 ----------------
function wrap01(t) { t %= 1; return t < 0 ? t + 1 : t; }

function updateProgress(kart, dt) {
  const t = wrap01(getSample(kart.state).t);
  let dT = t - kart.lastT;
  if (dT > 0.5) { // 倒着过线
    dT -= 1;
  } else if (dT < -0.5) { // 正向冲线
    dT += 1;
    if (kart.checkpoint) {
      kart.lap++;
      kart.checkpoint = false;
      if (kart.isPlayer) {
        const lapTime = raceTime - kart.lapStart;
        if (kart.lap > 1 && (!kart.bestLap || lapTime < kart.bestLap)) kart.bestLap = lapTime;
        kart.lapStart = raceTime;
        audio.beep(1180, 0.12, 'square', 0.2);
      }
      if (kart.lap > TOTAL_LAPS && !kart.finishTime) kart.finishTime = raceTime;
    }
  }
  if (t > 0.4 && t < 0.6) kart.checkpoint = true;
  kart.lastT = t;
  kart.wrongDelta = dT; // 供逆行检测用
}

function progressOf(kart) { return kart.lap + kart.lastT; }

function standings() {
  return [...karts].sort((a, b) => {
    if (a.finishTime && b.finishTime) return a.finishTime - b.finishTime;
    if (a.finishTime) return -1;
    if (b.finishTime) return 1;
    return progressOf(b) - progressOf(a);
  });
}

// ---------------- 相机 ----------------
const camPos = new THREE.Vector3(0, 120, 300);
const camLook = new THREE.Vector3(0, 0, 0);
let camFov = 62;

function snapChaseCam() {
  const s = karts[0].state;
  const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
  camPos.set(s.x - fx * 11, 5.6, s.z - fz * 11);
  camLook.set(s.x, 1.2, s.z);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

function updateChaseCam(dt, player) {
  const s = player.state;
  const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
  const desired = new THREE.Vector3(s.x - fx * 11, 5.6 + Math.min(2, Math.abs(s.speed) * 0.03), s.z - fz * 11);
  const k1 = 1 - Math.exp(-5.5 * dt);
  camPos.lerp(desired, k1);
  const lookDesired = new THREE.Vector3(s.x + fx * 7, 1.4, s.z + fz * 7);
  camLook.lerp(lookDesired, 1 - Math.exp(-9 * dt));

  // 撞墙震屏
  const shake = s.wallHit * 0.4;
  camera.position.set(
    camPos.x + (Math.random() - 0.5) * shake,
    camPos.y + (Math.random() - 0.5) * shake * 0.6,
    camPos.z + (Math.random() - 0.5) * shake,
  );
  camera.lookAt(camLook);
  s.wallHit *= Math.exp(-6 * dt);

  // 速度感 FOV
  const targetFov = 60 + (Math.abs(s.speed) / BOOST_SPEED) * 14 + (s.boostTime > 0 ? 8 : 0);
  camFov += (targetFov - camFov) * Math.min(1, 6 * dt);
  camera.fov = camFov;
  camera.updateProjectionMatrix();
}

function updateMenuCam(dt) {
  menuAngle += dt * 0.06;
  camPos.set(Math.cos(menuAngle) * 300, 130, Math.sin(menuAngle) * 300);
  camLook.set(0, 0, 0);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------------- HUD / 小地图 ----------------
const mmCtx = el.minimap.getContext('2d');
let mmPath = null, mmScale = 1, mmOffX = 0, mmOffY = 0;
// 依据当前 TRACK_POINTS 包围盒重建缩略图路径与缩放/偏移（换图后需重调）
function rebuildMinimap() {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of TRACK_POINTS) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 30, W = el.minimap.width, H = el.minimap.height;
  mmScale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
  mmOffX = pad - minX * mmScale + (W - pad * 2 - (maxX - minX) * mmScale) / 2;
  mmOffY = pad - minZ * mmScale + (H - pad * 2 - (maxZ - minZ) * mmScale) / 2;
  mmPath = new Path2D();
  TRACK_POINTS.forEach((p, i) => {
    const x = p.x * mmScale + mmOffX, y = p.z * mmScale + mmOffY;
    i === 0 ? mmPath.moveTo(x, y) : mmPath.lineTo(x, y);
  });
  mmPath.closePath();
}
rebuildMinimap();
const mmPt = (x, z) => [x * mmScale + mmOffX, z * mmScale + mmOffY];

function drawMinimap() {
  mmCtx.clearRect(0, 0, el.minimap.width, el.minimap.height);
  mmCtx.lineWidth = 9; mmCtx.lineJoin = 'round';
  mmCtx.strokeStyle = 'rgba(20,40,70,.55)';
  mmCtx.stroke(mmPath);
  mmCtx.lineWidth = 6;
  mmCtx.strokeStyle = 'rgba(255,255,255,.85)';
  mmCtx.stroke(mmPath);
  const s0 = sampleAt(0);
  const [sx, sy] = mmPt(s0.x, s0.z);
  mmCtx.fillStyle = '#ffd23f';
  mmCtx.beginPath(); mmCtx.arc(sx, sy, 4, 0, Math.PI * 2); mmCtx.fill();
  for (let i = karts.length - 1; i >= 0; i--) {
    const k = karts[i];
    const [x, y] = mmPt(k.state.x, k.state.z);
    mmCtx.beginPath();
    mmCtx.fillStyle = '#' + k.color.toString(16).padStart(6, '0');
    mmCtx.arc(x, y, k.isPlayer ? 7 : 5, 0, Math.PI * 2);
    mmCtx.fill();
    if (k.isPlayer) { mmCtx.lineWidth = 2.5; mmCtx.strokeStyle = '#fff'; mmCtx.stroke(); }
  }
}

const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
};

function updateHUD(dt) {
  const p = karts[0];
  el.speedVal.textContent = Math.round(Math.abs(p.state.speed) * 2.4);
  el.timeVal.textContent = fmtTime(raceTime);
  el.bestLapVal.textContent = p.bestLap ? `最快单圈 ${fmtTime(p.bestLap)}` : '';
  el.lapVal.textContent = `第 ${Math.min(Math.max(p.lap, 1), TOTAL_LAPS)}/${TOTAL_LAPS} 圈`;

  const rank = standings().indexOf(p) + 1;
  el.posVal.textContent = rank;
  el.posSuffix.textContent = '名';

  const s = p.state;
  let fill = 0;
  if (s.drifting) fill = Math.min(1, s.driftCharge / 2.4);
  else fill = Math.min(1, s.boostTime / 1.8);
  el.boostFill.style.width = (fill * 100).toFixed(1) + '%';

  // 漂移提示
  if (s.drifting) {
    el.driftTip.classList.remove('hidden');
    el.driftTip.textContent = s.driftCharge > 2.4 ? '涡轮蓄满！松开漂移！'
      : s.driftCharge > 1.2 ? '迷你涡轮就绪！' : '漂移蓄力中…';
  } else if (p.boostFlash > 0) {
    el.driftTip.classList.remove('hidden');
    el.driftTip.textContent = '迷你涡轮！';
    p.boostFlash -= dt;
  } else {
    el.driftTip.classList.add('hidden');
  }

  // 逆行检测
  if (mode === 'race' && Math.abs(s.speed) > 4) {
    p.wrongTimer = (p.wrongDelta < -0.00001) ? p.wrongTimer + dt : Math.max(0, p.wrongTimer - dt * 2);
  } else if (p.wrongTimer > 0) p.wrongTimer = Math.max(0, p.wrongTimer - dt * 2);
  el.wrongway.classList.toggle('hidden', p.wrongTimer < 1.2);

  drawMinimap();
}

// ---------------- 结算 ----------------
function showResults() {
  const order = standings();
  el.resultRows.innerHTML = '';
  order.forEach((k, i) => {
    const tr = document.createElement('tr');
    if (k.isPlayer) tr.className = 'me';
    let timeStr;
    if (k.finishTime) timeStr = fmtTime(k.finishTime);
    else {
      const remain = (TOTAL_LAPS + 1 - progressOf(k)) * TRACK_LENGTH;
      timeStr = '≈ ' + fmtTime(raceTime + remain / Math.max(18, Math.abs(k.state.speed) + 8));
    }
    tr.innerHTML = `<td>${i + 1}</td><td>${k.name}${k.isPlayer ? '（你）' : ''}</td><td>${timeStr}</td>`;
    el.resultRows.appendChild(tr);
  });
  el.results.classList.remove('hidden');
}

// ---------------- 每帧：车辆视觉同步 ----------------
function syncKartVisual(k, dt) {
  const s = k.state;
  k.mesh.position.set(s.x, 0, s.z);
  k.mesh.rotation.y = s.heading;

  k.wheelSpin -= (s.speed / 0.42) * dt; // 负号：前进时车轮绕 X 轴正向滚动
  for (const w of k.wheels) w.rotation.x = k.wheelSpin;
  for (const fp of k.frontPivots) fp.rotation.y = s.steer * 0.45;

  const tiltTarget = s.drifting ? -s.driftDir * 0.16 : -s.steer * 0.05 * Math.min(1, Math.abs(s.speed) / 20);
  k.body.rotation.z += (tiltTarget - k.body.rotation.z) * Math.min(1, 10 * dt);
}

// ---------------- 主循环 ----------------
const clock = new THREE.Clock();
let loadingHidden = false;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (paused) { renderer.render(scene, camera); return; }

  if (mode === 'menu') {
    updateMenuCam(dt);
    world.update(dt, camPos.x, camPos.z);
  } else {
    // —— 倒计时 ——
    if (mode === 'countdown') {
      countTimer += dt;
      const step = Math.floor(countTimer);
      if (step !== countShown && step <= 3) {
        countShown = step;
        if (step < 3) {
          el.countdown.textContent = String(3 - step);
          audio.beep(660, 0.16, 'square', 0.28);
        } else {
          el.countdown.textContent = 'GO!';
          audio.playGo();
          audio.startMusic();
          mode = 'race';
        }
        el.countdown.classList.remove('hidden');
        el.countdown.classList.remove('pop');
        void el.countdown.offsetWidth; // 重启动画
        el.countdown.classList.add('pop');
        setTimeout(() => el.countdown.classList.add('hidden'), 850);
      }
    }

    // —— 比赛 ——
    if (mode === 'race') {
      raceTime += dt;
      const pin = playerInput(dt);

      // 迷你涡轮触发音（检测漂移→结束的跳变）
      const p0 = karts[0].state;
      if (karts[0].prevDrift && !p0.drifting) {
        karts[0].boostFlash = 1.0;
        if (p0.boostTime > 0) audio.playBoost();
      }
      karts[0].prevDrift = p0.drifting;

      karts.forEach((k, i) => {
        let input;
        if (k.isPlayer) input = pin;
        else {
          input = k.driver.computeInput(k.state, statesArr, dt);
          if (input.stuckReset) respawnKart(k.state);
        }
        if (mode === 'race') updateKartPhysics(k.state, input, dt, TOTAL_LAPS);
        updateProgress(k, dt);
      });
      resolveKartKartCollisions(statesArr);

      // 玩家冲线
      if (karts[0].finishTime && mode === 'race') {
        mode = 'finished';
        finishShowTimer = 1.4;
        audio.stopMusic();
        audio.playFinish();
      }
    }

    // —— 结束后仍让车滑行（AI 继续跑） ——
    if (mode === 'finished') {
      if (finishShowTimer > 0) {
        finishShowTimer -= dt;
        if (finishShowTimer <= 0) showResults();
      }
      raceTime += 0; // 时间冻结
      karts.forEach((k, i) => {
        if (k.isPlayer) {
          // 玩家滑行减速
          const input = { throttle: 0, steer: 0, drift: false };
          updateKartPhysics(k.state, input, dt, TOTAL_LAPS);
        } else {
          const input = k.driver.computeInput(k.state, statesArr, dt);
          if (input.stuckReset) respawnKart(k.state);
          updateKartPhysics(k.state, input, dt, TOTAL_LAPS);
          updateProgress(k, dt);
        }
      });
      resolveKartKartCollisions(statesArr);
    }

    // —— 视觉/相机/HUD ——
    karts.forEach((k) => syncKartVisual(k, dt));
    updateChaseCam(dt, karts[0]);
    world.update(dt, karts[0].state.x, karts[0].state.z);
    updateHUD(dt);

    // 撞墙音（从高速变 wallHit 的瞬间）
    const ps = karts[0].state;
    if (ps.wallHit > 0.85 && !karts[0].hitPlayed) { audio.playHit(); karts[0].hitPlayed = true; }
    if (ps.wallHit < 0.5) karts[0].hitPlayed = false;

    // 引擎音
    audio.update(dt, {
      speed: ps.speed, maxSpeed: BOOST_SPEED,
      boosting: ps.boostTime > 0, drifting: ps.drifting, throttle: ps.throttle,
    });
  }

  renderer.render(scene, camera);
  if (!loadingHidden) { loadingHidden = true; el.loading.classList.add('hidden'); }
}
tick();
