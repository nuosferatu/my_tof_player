import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const app = document.getElementById('app');

function getContainerSize() {
  const width = app.clientWidth || window.innerWidth;
  const height = app.clientHeight || window.innerHeight;
  return { width, height };
}

// 创建渲染器并添加到页面（关闭 MSAA，点边缘更利落）
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(window.devicePixelRatio);
app.appendChild(renderer.domElement);

// 创建场景和相机
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// XY 平面参考网格：尺寸、分段、位置均为固定常量，不随点云包围盒变化
const XY_REFERENCE_GRID = {
  size: 5,
  divisions: 40,
  position: new THREE.Vector3(0, 0, 0),
  colorCenterLine: 0x6b7280,
  colorGrid: 0x374151,
};

const xyReferenceGrid = new THREE.GridHelper(
  XY_REFERENCE_GRID.size,
  XY_REFERENCE_GRID.divisions,
  XY_REFERENCE_GRID.colorCenterLine,
  XY_REFERENCE_GRID.colorGrid
);
xyReferenceGrid.rotation.x = Math.PI / 2;
xyReferenceGrid.position.copy(XY_REFERENCE_GRID.position);
scene.add(xyReferenceGrid);

const { width: initialW, height: initialH } = getContainerSize();
const initialAspect = initialH > 0 ? initialW / initialH : 1;
const camera = new THREE.PerspectiveCamera(60, initialAspect, 0.1, 1000);
camera.position.set(0, 0, 10);

function resizeRendererToContainer() {
  const { width, height } = getContainerSize();
  if (width <= 0 || height <= 0) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

resizeRendererToContainer();
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enablePan = true;
controls.enableZoom = true;
controls.screenSpacePanning = false;
controls.minPolarAngle = 1e-4;
controls.maxPolarAngle = Math.PI / 2;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

/** 当前目录内排序后的点云条目（仅路径 + 句柄/引用；切换显示时才读磁盘，不预载整目录） */
const POINT_CLOUD_EXT = /\.(txt|xyz|asc|csv)$/i;

/**
 * @typedef {{ path: string; handle?: FileSystemFileHandle; file?: File }} CloudListEntry
 */

/** @type {CloudListEntry[]} */
let cloudEntries = [];
let currentCloudIndex = 0;
/** @type {{ points: THREE.Points; geometry: THREE.BufferGeometry; material: THREE.PointsMaterial; radius: number } | null} */
let cloudEntry = null;

function createHardDiscTexture(resolution = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');
  const cx = resolution / 2;
  const r = resolution / 2 - 1;
  ctx.clearRect(0, 0, resolution, resolution);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

const discMap = createHardDiscTexture(32);
const categories = ['A', 'B', 'C'];

function parsePointCloudText(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const rawPoints = [];
  for (const line of lines) {
    const [xStr, yStr, zStr] = line.trim().split(/\s+/);
    const x = Number(xStr);
    const y = Number(yStr);
    const z = Number(zStr);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const color = { r: 1, g: 0.3, b: 0.3 };
    const category = 'A';
    rawPoints.push({ x, y, z, color, category });
  }
  return rawPoints;
}

/**
 * 传统 `<input webkitdirectory>`：只保留 File 引用（一般不预读内容），路径用于展示与排序。
 * @param {FileList} fileList
 * @returns {CloudListEntry[]}
 */
function fileListToCloudEntries(fileList) {
  return Array.from(fileList)
    .filter((f) => POINT_CLOUD_EXT.test(f.name))
    .map((f) => ({
      path: f.webkitRelativePath || f.name,
      file: f,
    }))
    .sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
    );
}

/**
 * File System Access API：递归收集点云文件的句柄，仅占位路径+句柄，按需 getFile()。
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} basePath
 * @returns {Promise<CloudListEntry[]>}
 */
async function walkPointCloudHandles(dirHandle, basePath = '') {
  /** @type {CloudListEntry[]} */
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    const rel = basePath ? `${basePath}/${name}` : name;
    if (handle.kind === 'file') {
      if (POINT_CLOUD_EXT.test(name)) {
        out.push({ path: rel, handle });
      }
    } else if (handle.kind === 'directory') {
      out.push(...(await walkPointCloudHandles(handle, rel)));
    }
  }
  return out;
}

/**
 * @param {CloudListEntry} entry
 * @returns {Promise<string>}
 */
async function readCloudEntryText(entry) {
  if (entry.handle) {
    const file = await entry.handle.getFile();
    return file.text();
  }
  if (entry.file) {
    return entry.file.text();
  }
  throw new Error('无效的点云条目');
}

function disposeCurrentCloud() {
  if (!cloudEntry) return;
  scene.remove(cloudEntry.points);
  cloudEntry.geometry.dispose();
  cloudEntry.material.dispose();
  cloudEntry = null;
}

function fitCameraToCloud(center, radius) {
  const r = Math.max(radius, 1e-6);
  controls.target.copy(center);
  const fovRad = (camera.fov * Math.PI) / 180;
  let dist = (r / Math.sin(fovRad / 2)) * 1.25;
  dist = Math.max(dist, r * 2);
  camera.position.copy(center.clone().add(new THREE.Vector3(dist * 0.35, dist * 0.25, dist)));
  camera.near = Math.max(dist / 500, r / 1000);
  camera.far = Math.max(dist * 50, r * 20);
  camera.updateProjectionMatrix();
  controls.minDistance = Math.max(r * 0.02, 1e-3);
  controls.maxDistance = Math.max(r * 50, 10);
  controls.update();
}

/**
 * @param {Array<{ x: number; y: number; z: number; color: { r: number; g: number; b: number }; category: string }>} rawPoints
 */
function showPointCloud(rawPoints) {
  disposeCurrentCloud();

  if (rawPoints.length === 0) {
    return null;
  }

  const positions = new Float32Array(rawPoints.length * 3);
  const colors = new Float32Array(rawPoints.length * 3);
  const categoryIndexArray = new Float32Array(rawPoints.length);

  rawPoints.forEach((p, i) => {
    const i3 = i * 3;
    positions[i3 + 0] = p.x;
    positions[i3 + 1] = p.y;
    positions[i3 + 2] = p.z;
    colors[i3 + 0] = p.color.r;
    colors[i3 + 1] = p.color.g;
    colors[i3 + 2] = p.color.b;
    categoryIndexArray[i] = categories.indexOf(p.category);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('categoryIndex', new THREE.BufferAttribute(categoryIndexArray, 1));

  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  const radius = Math.max(sphere.radius, 1e-6);
  const pointSize = THREE.MathUtils.clamp(radius * 0.0022, 0.004, 0.12);

  const material = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: true,
    sizeAttenuation: true,
    map: discMap,
    transparent: true,
    alphaTest: 0.5,
    depthWrite: true,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);

  const center = sphere.center.clone();
  fitCameraToCloud(center, radius);

  cloudEntry = { points, geometry, material, radius };
  return cloudEntry;
}

renderer.domElement.addEventListener('dblclick', (event) => {
  if (!cloudEntry) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  raycaster.params.Points.threshold = Math.max(
    cloudEntry.material.size * 0.2,
    cloudEntry.radius * 0.012
  );
  const hits = raycaster.intersectObject(cloudEntry.points, false);
  if (hits.length > 0) {
    controls.target.copy(hits[0].point);
    controls.update();
  }
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', resizeRendererToContainer);

/** @type {HTMLButtonElement | null} */
let btnPrev = null;
/** @type {HTMLButtonElement | null} */
let btnNext = null;
/** @type {HTMLSpanElement | null} */
let fileStatusEl = null;

function updateNavButtons() {
  const n = cloudEntries.length;
  if (btnPrev) btnPrev.disabled = n <= 1 || currentCloudIndex <= 0;
  if (btnNext) btnNext.disabled = n <= 1 || currentCloudIndex >= n - 1;
}

function setEmptyDirectoryStatus() {
  if (fileStatusEl) fileStatusEl.textContent = '未选择目录或无匹配点云文件';
}

async function loadAndShowIndex(index) {
  if (index < 0 || index >= cloudEntries.length) return;
  currentCloudIndex = index;
  const entry = cloudEntries[currentCloudIndex];
  const n = cloudEntries.length;
  try {
    const text = await readCloudEntryText(entry);
    const raw = parsePointCloudText(text);
    showPointCloud(raw);
    if (fileStatusEl) {
      const suffix = raw.length === 0 ? '（无有效点）' : '';
      fileStatusEl.textContent = `${currentCloudIndex + 1} / ${n} · ${entry.path}${suffix}`;
    }
  } catch (e) {
    console.error(e);
    disposeCurrentCloud();
    if (fileStatusEl) {
      fileStatusEl.textContent = `读取失败: ${entry.path}`;
    }
  }
  updateNavButtons();
}

/**
 * 选中新目录后：只保存条目列表并加载当前索引对应的一个文件。
 * @param {CloudListEntry[]} entries
 */
async function applyCloudDirectory(entries) {
  cloudEntries = entries;
  currentCloudIndex = 0;
  if (entries.length === 0) {
    disposeCurrentCloud();
    setEmptyDirectoryStatus();
    updateNavButtons();
    return;
  }
  await loadAndShowIndex(0);
}

function setupToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-toolbar';

  const btnOpen = document.createElement('button');
  btnOpen.type = 'button';
  btnOpen.textContent = '打开目录';

  const inputDir = document.createElement('input');
  inputDir.type = 'file';
  inputDir.setAttribute('webkitdirectory', '');
  inputDir.multiple = true;
  inputDir.style.display = 'none';

  btnPrev = document.createElement('button');
  btnPrev.type = 'button';
  btnPrev.textContent = '上一个';
  btnPrev.disabled = true;

  btnNext = document.createElement('button');
  btnNext.type = 'button';
  btnNext.textContent = '下一个';
  btnNext.disabled = true;

  fileStatusEl = document.createElement('span');
  fileStatusEl.className = 'viewer-file-status';
  fileStatusEl.textContent = '请选择包含点云文件的目录';

  btnOpen.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await window.showDirectoryPicker();
        const entries = await walkPointCloudHandles(dirHandle);
        entries.sort((a, b) =>
          a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
        );
        await applyCloudDirectory(entries);
      } catch (e) {
        if (e && typeof e === 'object' && 'name' in e && e.name === 'AbortError') return;
        console.error(e);
        if (fileStatusEl) fileStatusEl.textContent = '打开目录失败';
      }
      return;
    }
    inputDir.click();
  });

  inputDir.addEventListener('change', () => {
    const list = inputDir.files;
    if (!list || list.length === 0) return;
    const entries = fileListToCloudEntries(list);
    void applyCloudDirectory(entries);
    inputDir.value = '';
  });

  btnPrev.addEventListener('click', () => {
    void loadAndShowIndex(currentCloudIndex - 1);
  });

  btnNext.addEventListener('click', () => {
    void loadAndShowIndex(currentCloudIndex + 1);
  });

  toolbar.append(btnOpen, inputDir, btnPrev, btnNext, fileStatusEl);
  document.body.appendChild(toolbar);
  updateNavButtons();
}

setupToolbar();
