// 赛道几何校验：自交检测 + 最小间距 + 最小曲率半径 + 长度
import {
  TRACKS, TRACK_COUNT, setTrack, sampleAt, SAMPLE_COUNT, WALL_HALF, TRACK_LENGTH,
} from '../../src/track-data.js';

const MIN_SEP = 40;        // 采样点环形间隔小于此值视为“相邻”，不参与自交判定
const SAFE_GAP = WALL_HALF * 2 + 5; // 不同路段最小安全间距

let allOk = true;
for (let k = 0; k < TRACK_COUNT; k++) {
  setTrack(k);
  const P = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) P.push(sampleAt(i / SAMPLE_COUNT));

  // 1) 自交：非相邻采样点最小间距
  let minGap = Infinity, minPair = null;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    for (let j = i + 1; j < SAMPLE_COUNT; j++) {
      const sep = Math.min(j - i, SAMPLE_COUNT - (j - i));
      if (sep < MIN_SEP) continue;
      const d = Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
      if (d < minGap) { minGap = d; minPair = [i, j]; }
    }
  }

  // 2) 曲率半径：连续三点的外接圆半径
  let minR = Infinity, minRAt = -1;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const a = P[i], b = P[(i + 1) % SAMPLE_COUNT], c = P[(i + 2) % SAMPLE_COUNT];
    const ax = a.x, az = a.z, bx = b.x, bz = b.z, cx = c.x, cz = c.z;
    const A = Math.hypot(bx - ax, bz - az);
    const B = Math.hypot(cx - bx, cz - bz);
    const C = Math.hypot(cx - ax, cz - az);
    const area2 = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)); // 2*面积
    const r = area2 < 1e-9 ? Infinity : (A * B * C) / area2;
    if (r < minR) { minR = r; minRAt = i; }
  }

  const okGap = minGap > SAFE_GAP;
  const okR = minR > 7;
  if (!okGap || !okR) allOk = false;
  console.log(
    `[${k}] ${TRACKS[k].name.padEnd(6)} len=${TRACK_LENGTH.toFixed(0).padStart(5)}m ` +
    `minGap=${minGap.toFixed(1).padStart(6)}m(需>${SAFE_GAP.toFixed(1)}) ${okGap ? 'OK' : 'XX ' + minPair} ` +
    `minR=${minR.toFixed(1).padStart(6)}m @(${(P[minRAt + 1] || P[0]).x.toFixed(0)},${(P[minRAt + 1] || P[0]).z.toFixed(0)}) ${okR ? 'OK' : 'XX'}`,
  );
}
console.log(allOk ? 'ALL OK' : 'FAILED');
process.exit(allOk ? 0 : 1);
