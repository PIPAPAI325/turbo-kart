// ============================================================
// 共享赛道数据 —— 物理(physics.js) / 美术(environment.js) / AI(ai.js)
// 的唯一数据源。坐标约定：Three.js XZ 平面，Y 轴向上。
// heading 约定：朝向角 h 的前向向量 = (sin h, cos h)，h=0 朝 +Z，
// h 增大 = 左转（朝 +X 方向旋转）。
// ============================================================
import * as THREE from 'three';

export const TRACK_WIDTH = 18;   // 含路肩区总宽
export const ROAD_HALF = 8;      // 沥青路面半宽
export const WALL_HALF = 9.2;    // 护栏中心线距赛道中心线距离
export const KART_RADIUS = 1.0;  // 卡丁车碰撞半径
export const SAMPLE_COUNT = 600; // 中心线采样点数
export const TOTAL_LAPS = 3;     // 比赛圈数
export const START_T = 0.0;      // 起点线参数位置

// 加速带（沿赛道参数 t 的位置），物理与美术共用
export const BOOST_PADS = [0.13, 0.38, 0.57, 0.82];
export const BOOST_PAD_HALF_T = 0.0035;   // 加速带沿赛道方向半长(参数t)
export const BOOST_PAD_HALF_LAT = 3.6;    // 加速带横向半宽

// 车手名单：main.js 依此分配颜色与名字，美术用 color 上色
export const ROSTER = [
  { name: '疾风', color: 0xe63946 },
  { name: '酷豹', color: 0xf4a261 },
  { name: '蓝鲨', color: 0x2a6fdb },
  { name: '绿蛙', color: 0x2a9d3f },
  { name: '紫猫', color: 0x8338ec },
  { name: '橙熊', color: 0xff8500 },
  { name: '粉兔', color: 0xff5fa2 },
  { name: '黑鹰', color: 0x39404d },
];

// ---------- 中心线控制点（顺时针行进方向即 t 增大方向） ----------
const CONTROL_POINTS = [
  [0, -150], [100, -150], [185, -115], [215, -30], [165, 30],
  [185, 105], [115, 160], [10, 150], [-35, 95], [-115, 120],
  [-195, 85], [-210, -15], [-155, -70], [-70, -85], [-45, -135],
];

const curve = new THREE.CatmullRomCurve3(
  CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
  true, 'catmullrom', 0.5
);

export const TRACK_LENGTH = curve.getLength();

const pts = [], tans = [], norms = [];
for (let i = 0; i < SAMPLE_COUNT; i++) {
  const t = i / SAMPLE_COUNT;
  const p = curve.getPointAt(t);
  const tan = curve.getTangentAt(t).normalize();
  pts.push({ x: p.x, z: p.z });
  tans.push({ x: tan.x, z: tan.z });
  // 左法线 = up × tangent（lateral > 0 表示在中心线左侧）
  norms.push({ x: tan.z, z: -tan.x });
}

/** 采样后的中心线点/切线/法线数组（美术与 minimap 直接用） */
export const TRACK_POINTS = pts;
export const TRACK_TANGENTS = tans;
export const TRACK_NORMALS = norms;

const SEG_LEN = TRACK_LENGTH / SAMPLE_COUNT;

/**
 * 按参数 t(0~1) 采样中心线，返回插值后的
 * { x, z, tx, tz, nx, nz, t, index }
 */
export function sampleAt(t) {
  t = ((t % 1) + 1) % 1;
  const f = t * SAMPLE_COUNT;
  const i = Math.floor(f) % SAMPLE_COUNT;
  const j = (i + 1) % SAMPLE_COUNT;
  const a = f - Math.floor(f);
  const L = (A, B) => A + (B - A) * a;
  const px = L(pts[i].x, pts[j].x), pz = L(pts[i].z, pts[j].z);
  const tn = tans[i], n = norms[i];
  const len = Math.hypot(tn.x, tn.z) || 1;
  return {
    x: px, z: pz,
    tx: tn.x / len, tz: tn.z / len,
    nx: n.x / len, nz: n.z / len,
    t, index: i,
  };
}

/**
 * 求某点最近中心线点。hint 传入上次 index 可做窗口快速搜索。
 * 返回 { index, t, dist, lateral }  lateral 为带符号横向偏移(左正)。
 */
export function nearest(x, z, hint = -1) {
  const N = SAMPLE_COUNT;
  let best = -1, bestD = Infinity;
  const scan = (from, to) => {
    for (let k = from; k <= to; k++) {
      const i = ((k % N) + N) % N;
      const dx = x - pts[i].x, dz = z - pts[i].z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  };
  if (hint >= 0) scan(hint - 40, hint + 40);
  if (best < 0 || bestD > 3600) { bestD = Infinity; scan(0, N - 1); }
  const i = best;
  const dx = x - pts[i].x, dz = z - pts[i].z;
  const n = norms[i], tn = tans[i];
  const lateral = dx * n.x + dz * n.z;
  const along = dx * tn.x + dz * tn.z;
  let t = (i + Math.max(-0.9, Math.min(0.9, along / SEG_LEN))) / N;
  t = ((t % 1) + 1) % 1;
  return { index: i, t, dist: Math.sqrt(bestD), lateral };
}

/** t 与 lateral 是否落在某个加速带上 */
export function nearBoostPad(t, lateral) {
  for (const pt of BOOST_PADS) {
    let d = Math.abs(t - pt);
    d = Math.min(d, 1 - d);
    if (d < BOOST_PAD_HALF_T && Math.abs(lateral) < BOOST_PAD_HALF_LAT) return true;
  }
  return false;
}

/** 起跑排位：i=0..7，两列交错排在起点线之后 */
export function getStartGrid(i) {
  const row = Math.floor(i / 2), col = i % 2;
  const t = 1 - (0.008 + row * 0.005);
  const s = sampleAt(t);
  const latOff = col === 0 ? -3.4 : 3.4;
  return {
    x: s.x + s.nx * latOff,
    z: s.z + s.nz * latOff,
    heading: Math.atan2(s.tx, s.tz),
    t,
  };
}

/** 角度差归一化到 [-PI, PI] */
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
