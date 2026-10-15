// ============================================================
// 场景美术模块 —— 天空/光照/赛道网格/护栏/加速带/装饰
// 对外接口：
//   createWorld(scene, renderer) -> { update(dt, px, pz), sunLight }
//   createKartMesh(colorHex)     -> Group（userData: wheels/frontPivots/body）
// 全部赛道几何复用 track-data.js 的采样数据，保证与物理一致。
// ============================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  TRACK_POINTS, TRACK_NORMALS, SAMPLE_COUNT, TRACK_LENGTH,
  ROAD_HALF, WALL_HALF,
  BOOST_PADS, BOOST_PAD_HALF_T, BOOST_PAD_HALF_LAT,
  nearest,
} from './track-data.js';

// ---------------- 通用丝带网格 ----------------
// 沿中心线采样点，把两条边（edge = {lat, h}，lat 为横向偏移、h 为高度）
// 连成三角带。iStart 可为负（自动取模），count 段。
function buildRibbon(iStart, count, edgeA, edgeB, opts = {}) {
  const pos = [], uvs = [], cols = [], idx = [];
  const vScale = opts.vScale || 1;
  for (let k = 0; k <= count; k++) {
    const i = ((iStart + k) % SAMPLE_COUNT + SAMPLE_COUNT) % SAMPLE_COUNT;
    const p = TRACK_POINTS[i], n = TRACK_NORMALS[i];
    pos.push(p.x + n.x * edgeA.lat, edgeA.h, p.z + n.z * edgeA.lat);
    pos.push(p.x + n.x * edgeB.lat, edgeB.h, p.z + n.z * edgeB.lat);
    const v = (k / count) * vScale;
    uvs.push(0, v, 1, v);
    if (opts.colorFn) {
      const c = opts.colorFn(i);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  for (let k = 0; k < count; k++) {
    const a = k * 2, b = k * 2 + 1, c = k * 2 + 2, d = k * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (opts.colorFn) geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// 虚线中心线：只在满足条件的采样段生成面片
function buildDashes(edgeA, edgeB, period, duty) {
  const pos = [], idx = [];
  let v = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    if (i % period >= Math.floor(period * duty)) continue;
    const j = (i + 1) % SAMPLE_COUNT;
    const p1 = TRACK_POINTS[i], n1 = TRACK_NORMALS[i];
    const p2 = TRACK_POINTS[j], n2 = TRACK_NORMALS[j];
    const base = v * 4;
    pos.push(
      p1.x + n1.x * edgeA.lat, edgeA.h, p1.z + n1.z * edgeA.lat,
      p1.x + n1.x * edgeB.lat, edgeB.h, p1.z + n1.z * edgeB.lat,
      p2.x + n2.x * edgeA.lat, edgeA.h, p2.z + n2.z * edgeA.lat,
      p2.x + n2.x * edgeB.lat, edgeB.h, p2.z + n2.z * edgeB.lat,
    );
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    v++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------- Canvas 贴图工具 ----------------
function canvasTexture(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeChevronTexture() {
  return canvasTexture(128, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#ff8c1a'); g.addColorStop(1, '#ff6a00');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 16;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(18, 96); ctx.lineTo(64, 42); ctx.lineTo(110, 96);
    ctx.stroke();
  });
}

function makeCheckerTexture() {
  return canvasTexture(256, 64, (ctx) => {
    const cw = 256 / 16, ch = 64 / 4;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 16; c++) {
        ctx.fillStyle = (r + c) % 2 ? '#111318' : '#f4f6f8';
        ctx.fillRect(c * cw, r * ch, cw, ch);
      }
    }
  });
}

function makeBannerTexture() {
  return canvasTexture(1024, 128, (ctx) => {
    ctx.fillStyle = '#1d3557'; ctx.fillRect(0, 0, 1024, 128);
    ctx.fillStyle = '#ffd23f';
    for (let x = 0; x < 1024; x += 32) {
      ctx.fillRect(x, 0, 16, 10); ctx.fillRect(x + 16, 118, 16, 10);
    }
    ctx.font = '900 64px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = '#12263f';
    ctx.strokeText('极速卡丁车 · TURBO KART', 512, 66);
    ctx.fillStyle = '#fff';
    ctx.fillText('极速卡丁车 · TURBO KART', 512, 66);
  });
}

// ============================================================
// 世界创建
// ============================================================
export function createWorld(scene, renderer) {
  // ---------- 天空 & 太阳 ----------
  const sky = new Sky();
  sky.scale.setScalar(3500);
  scene.add(sky);

  const sunDir = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(90 - 46);   // 太阳仰角 46°
  const theta = THREE.MathUtils.degToRad(128);     // 方位角
  sunDir.setFromSphericalCoords(1, phi, theta);
  const u = sky.material.uniforms;
  u.turbidity.value = 4.5;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(sunDir);

  scene.fog = new THREE.Fog(0xcfe6f5, 500, 2400);

  // ---------- 光照 ----------
  scene.add(new THREE.HemisphereLight(0xbfdfff, 0x7cbf5f, 0.75));
  const sunLight = new THREE.DirectionalLight(0xfff2d8, 1.45);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 420;
  sunLight.shadow.camera.left = -70;
  sunLight.shadow.camera.right = 70;
  sunLight.shadow.camera.top = 70;
  sunLight.shadow.camera.bottom = -70;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.03;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // ---------- 地面草地 ----------
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2400, 48),
    new THREE.MeshLambertMaterial({ color: 0x74bf4e }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- 远山 ----------
  const mountainGeo = new THREE.ConeGeometry(1, 1, 6);
  const mountainMatA = new THREE.MeshLambertMaterial({ color: 0x8fb98a });
  const mountainMatB = new THREE.MeshLambertMaterial({ color: 0x7aa678 });
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2 + Math.sin(i * 7.3) * 0.3;
    const dist = 950 + (i * 137 % 700);
    const r = 130 + (i * 89 % 170);
    const h = 100 + (i * 61 % 170);
    const m = new THREE.Mesh(mountainGeo, i % 2 ? mountainMatA : mountainMatB);
    m.scale.set(r, h, r);
    m.position.set(Math.cos(ang) * dist, h / 2 - 6, Math.sin(ang) * dist);
    scene.add(m);
  }

  // ---------- 赛道丝带 ----------
  const N = SAMPLE_COUNT;
  const SEG_LEN = TRACK_LENGTH / N;

  // 沥青路面
  const asphalt = new THREE.Mesh(
    buildRibbon(0, N, { lat: -ROAD_HALF, h: 0.02 }, { lat: ROAD_HALF, h: 0.02 }),
    new THREE.MeshLambertMaterial({ color: 0x43484f }),
  );
  asphalt.receiveShadow = true;
  scene.add(asphalt);

  // 红白路肩（左右）
  const curbMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const curbColor = (i) => (Math.floor(i / 6) % 2
    ? new THREE.Color(0xe23b3b) : new THREE.Color(0xf4f6f8));
  for (const s of [1, -1]) {
    const curb = new THREE.Mesh(
      buildRibbon(0, N,
        { lat: s * ROAD_HALF, h: 0.03 }, { lat: s * WALL_HALF, h: 0.045 },
        { colorFn: curbColor }),
      curbMat,
    );
    curb.receiveShadow = true;
    scene.add(curb);
  }

  // 白色边线
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const s of [1, -1]) {
    scene.add(new THREE.Mesh(
      buildRibbon(0, N,
        { lat: s * (ROAD_HALF - 0.55), h: 0.035 },
        { lat: s * (ROAD_HALF - 0.18), h: 0.035 }),
      lineMat,
    ));
  }

  // 中央虚线
  scene.add(new THREE.Mesh(
    buildDashes({ lat: -0.2, h: 0.035 }, { lat: 0.2, h: 0.035 }, 12, 0.5),
    lineMat,
  ));

  // ---------- 护栏（白色墙身 + 红色顶栏） ----------
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xeef2f7, side: THREE.DoubleSide });
  const railMat = new THREE.MeshLambertMaterial({ color: 0xd7263d, side: THREE.DoubleSide });
  for (const s of [1, -1]) {
    const wall = new THREE.Mesh(
      buildRibbon(0, N, { lat: s * WALL_HALF, h: 0 }, { lat: s * WALL_HALF, h: 1.0 }),
      wallMat,
    );
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
    scene.add(new THREE.Mesh(
      buildRibbon(0, N,
        { lat: s * WALL_HALF, h: 1.0 }, { lat: s * (WALL_HALF + 0.4), h: 1.0 }),
      railMat,
    ));
    // 支柱
    const postGeo = new THREE.BoxGeometry(0.22, 1.15, 0.22);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
    for (let i = 0; i < N; i += 15) {
      const p = TRACK_POINTS[i], n = TRACK_NORMALS[i];
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(p.x + n.x * s * WALL_HALF, 0.55, p.z + n.z * s * WALL_HALF);
      post.castShadow = true;
      scene.add(post);
    }
  }

  // ---------- 加速带 ----------
  const chevronTex = makeChevronTexture();
  chevronTex.wrapS = chevronTex.wrapT = THREE.RepeatWrapping;
  const padMat = new THREE.MeshBasicMaterial({ map: chevronTex, side: THREE.DoubleSide });
  for (const padT of BOOST_PADS) {
    const count = Math.max(2, Math.round(2 * BOOST_PAD_HALF_T * N));
    const iStart = Math.round((padT - BOOST_PAD_HALF_T) * N);
    const arcLen = 2 * BOOST_PAD_HALF_T * TRACK_LENGTH;
    const pad = new THREE.Mesh(
      buildRibbon(iStart, count,
        { lat: -BOOST_PAD_HALF_LAT, h: 0.05 }, { lat: BOOST_PAD_HALF_LAT, h: 0.05 },
        { vScale: Math.max(1, Math.round(arcLen / 4)) }),
      padMat,
    );
    scene.add(pad);
  }

  // ---------- 起点线 + 拱门 ----------
  const checkerTex = makeCheckerTexture();
  const checker = new THREE.Mesh(
    buildRibbon(N - 1, 2,
      { lat: -ROAD_HALF, h: 0.045 }, { lat: ROAD_HALF, h: 0.045 }),
    new THREE.MeshBasicMaterial({ map: checkerTex }),
  );
  scene.add(checker);

  const startS = TRACK_POINTS[0], startN = TRACK_NORMALS[0];
  const arch = new THREE.Group();
  arch.position.set(startS.x, 0, startS.z);
  arch.rotation.y = Math.atan2(-startN.z, startN.x); // 使拱门局部 +X 对齐赛道法线（横跨赛道）
  const pillarGeo = new THREE.CylinderGeometry(0.55, 0.7, 7, 12);
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
  for (const s of [1, -1]) {
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(s * (WALL_HALF + 1.1), 3.5, 0);
    pillar.castShadow = true;
    arch.add(pillar);
  }
  const bannerTex = makeBannerTexture();
  const bannerMats = [
    null, null, null, null,
    new THREE.MeshBasicMaterial({ map: bannerTex }),
    new THREE.MeshBasicMaterial({ map: bannerTex }),
  ];
  const banner = new THREE.Mesh(new THREE.BoxGeometry(2 * (WALL_HALF + 1.1), 1.9, 0.4), bannerMats);
  banner.position.y = 7.4;
  banner.castShadow = true;
  arch.add(banner);
  scene.add(arch);

  // ---------- 树木（实例化） ----------
  const treeSpots = [];
  let attempts = 0;
  while (treeSpots.length < 64 && attempts < 600) {
    attempts++;
    const x = (Math.random() * 2 - 1) * 700;
    const z = (Math.random() * 2 - 1) * 700;
    if (nearest(x, z, -1).dist < 15) continue;
    treeSpots.push({ x, z, s: 0.8 + Math.random() * 1.1, rot: Math.random() * Math.PI * 2 });
  }
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.26, 1.5, 7),
    new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
    treeSpots.length,
  );
  const leafMeshA = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.6, 2.4, 8),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    treeSpots.length,
  );
  const leafMeshB = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.15, 2.0, 8),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    treeSpots.length,
  );
  const dummy = new THREE.Object3D();
  const greens = [0x2f8f3a, 0x3aa54a, 0x57b85c, 0x2a9d3f];
  const tmpColor = new THREE.Color();
  treeSpots.forEach((t, i) => {
    dummy.rotation.set(0, t.rot, 0);
    dummy.position.set(t.x, 0.75 * t.s, t.z);
    dummy.scale.setScalar(t.s);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, (1.5 + 1.2) * t.s, t.z);
    dummy.updateMatrix();
    leafMeshA.setMatrixAt(i, dummy.matrix);
    leafMeshA.setColorAt(i, tmpColor.setHex(greens[i % greens.length]));

    dummy.position.set(t.x, (1.5 + 2.4) * t.s, t.z);
    dummy.updateMatrix();
    leafMeshB.setMatrixAt(i, dummy.matrix);
    leafMeshB.setColorAt(i, tmpColor.setHex(greens[(i + 1) % greens.length]));
  });
  trunkMesh.castShadow = leafMeshA.castShadow = leafMeshB.castShadow = true;
  scene.add(trunkMesh, leafMeshA, leafMeshB);

  // ---------- 云朵（实例化，整组慢速旋转） ----------
  const cloudGroup = new THREE.Group();
  const puffGeo = new THREE.SphereGeometry(1, 10, 8);
  const puffMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.94 });
  const puffList = [];
  for (let c = 0; c < 16; c++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 220 + Math.random() * 620;
    const cy = 95 + Math.random() * 75;
    const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
    const puffs = 4 + Math.floor(Math.random() * 3);
    for (let p = 0; p < puffs; p++) {
      puffList.push({
        x: cx + (Math.random() - 0.5) * 26,
        y: cy + (Math.random() - 0.5) * 6,
        z: cz + (Math.random() - 0.5) * 20,
        s: 7 + Math.random() * 9,
      });
    }
  }
  const cloudMesh = new THREE.InstancedMesh(puffGeo, puffMat, puffList.length);
  puffList.forEach((p, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.set(p.s, p.s * 0.52, p.s * 0.8);
    dummy.updateMatrix();
    cloudMesh.setMatrixAt(i, dummy.matrix);
  });
  cloudGroup.add(cloudMesh);
  scene.add(cloudGroup);

  // ---------- 热气球 ----------
  const balloonGroup = new THREE.Group();
  const balloons = [];
  const balloonColors = [0xe63946, 0xffd23f, 0x2a6fdb];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    const env = new THREE.Mesh(
      new THREE.SphereGeometry(6, 14, 12),
      new THREE.MeshLambertMaterial({ color: balloonColors[i] }),
    );
    env.scale.set(1, 1.2, 1);
    const basket = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.6, 2),
      new THREE.MeshLambertMaterial({ color: 0x8a5a2b }),
    );
    basket.position.y = -8.6;
    g.add(env, basket);
    const ang = i * 2.1 + 0.7;
    const bx = Math.cos(ang) * (180 + i * 90);
    const bz = Math.sin(ang) * (180 + i * 90);
    g.position.set(bx, 55 + i * 18, bz);
    balloonGroup.add(g);
    balloons.push({ g, baseY: 55 + i * 18, phase: i * 1.9 });
  }
  scene.add(balloonGroup);

  // ---------- 每帧更新 ----------
  let elapsed = 0;
  function update(dt, px, pz) {
    elapsed += dt;
    cloudGroup.rotation.y += dt * 0.004;
    balloonGroup.rotation.y -= dt * 0.006;
    for (const b of balloons) {
      b.g.position.y = b.baseY + Math.sin(elapsed * 0.4 + b.phase) * 2.5;
    }
    chevronTex.offset.y -= dt * 0.9;   // 加速带箭头流动
    // 太阳阴影相机跟随玩家
    sunLight.position.set(px + sunDir.x * 180, sunDir.y * 180 + 25, pz + sunDir.z * 180);
    sunLight.target.position.set(px, 0, pz);
    sunLight.target.updateMatrixWorld();
  }

  return { update, sunLight };
}

// ============================================================
// 卡丁车模型（车头朝 +Z，与 heading 约定一致）
// ============================================================
export function createKartMesh(colorHex) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);

  const paint = new THREE.MeshLambertMaterial({ color: colorHex });
  const dark = new THREE.MeshLambertMaterial({ color: 0x22262e });
  const grey = new THREE.MeshLambertMaterial({ color: 0x8a9099 });
  const white = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x161a22 });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    body.add(m);
    return m;
  };

  // 底盘 & 车身
  add(new THREE.BoxGeometry(1.5, 0.12, 2.7), dark, 0, 0.3, 0);
  add(new THREE.BoxGeometry(1.32, 0.3, 2.45), paint, 0, 0.46, 0);
  add(new THREE.BoxGeometry(0.72, 0.26, 0.7), paint, 0, 0.44, 1.42);          // 车鼻
  add(new THREE.BoxGeometry(1.5, 0.16, 0.28), white, 0, 0.36, 1.78);          // 前保险杠
  add(new THREE.BoxGeometry(0.3, 0.24, 1.3), dark, 0.82, 0.46, -0.1);         // 侧舱
  add(new THREE.BoxGeometry(0.3, 0.24, 1.3), dark, -0.82, 0.46, -0.1);
  add(new THREE.BoxGeometry(1.2, 0.14, 0.3), dark, 0, 0.42, -1.5);            // 后保险杠

  // 座椅 & 车手
  add(new THREE.BoxGeometry(0.64, 0.52, 0.16), dark, 0, 0.82, -0.62);
  add(new THREE.BoxGeometry(0.64, 0.12, 0.5), dark, 0, 0.58, -0.3);
  add(new THREE.BoxGeometry(0.52, 0.44, 0.36), paint, 0, 0.95, -0.28);        // 赛车服
  add(new THREE.SphereGeometry(0.27, 12, 10), white, 0, 1.32, -0.26);         // 头盔
  add(new THREE.BoxGeometry(0.36, 0.13, 0.12), glass, 0, 1.33, -0.03);        // 护目镜

  // 方向盘 / 尾翼 / 排气管
  add(new THREE.TorusGeometry(0.17, 0.05, 8, 16), dark, 0, 0.86, 0.42, -1.0);
  add(new THREE.BoxGeometry(1.3, 0.08, 0.44), paint, 0, 1.0, -1.28);          // 尾翼
  add(new THREE.BoxGeometry(0.08, 0.34, 0.08), dark, 0.45, 0.8, -1.28);
  add(new THREE.BoxGeometry(0.08, 0.34, 0.08), dark, -0.45, 0.8, -1.28);
  add(new THREE.CylinderGeometry(0.07, 0.09, 0.42, 8), grey, 0.22, 0.56, -1.52, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.07, 0.09, 0.42, 8), grey, -0.22, 0.56, -1.52, Math.PI / 2);

  // 车轮：spin 组绕 X 自转；前轮外包 steer 组绕 Y 转向
  const wheels = [], frontPivots = [];
  const wheelMesh = (r, w) => {
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 14), dark);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.04, 8), grey);
    hub.rotation.z = Math.PI / 2;
    spin.add(tire, hub);
    return spin;
  };
  // 前轮
  for (const s of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.84, 0.42, 0.95);
    const spin = wheelMesh(0.42, 0.3);
    pivot.add(spin);
    g.add(pivot);
    wheels.push(spin);
    frontPivots.push(pivot);
  }
  // 后轮（略大）
  for (const s of [1, -1]) {
    const spin = wheelMesh(0.46, 0.38);
    spin.position.set(s * 0.9, 0.46, -0.98);
    g.add(spin);
    wheels.push(spin);
  }

  g.userData = { wheels, frontPivots, body };
  return g;
}
