import * as pdfjsLib from "../pdfjs/pdf.mjs";
import { buildIndex, findAll, rangesFor, normalizeQuery } from "./textsearch.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdfjs/pdf.worker.mjs");
const asset = (path) => chrome.runtime.getURL("pdfjs/" + path);

/* ------------------------------------------------------------------ */
/* Helpers and constants                                               */
/* ------------------------------------------------------------------ */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const tick = () => new Promise((r) => setTimeout(r, 0));

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const PAD = 12; // padding around the page column
const GAP = 8; // gap between pages
const MAX_LIVE_PAGES = 10; // rendered pages kept in memory
const MAX_PIXELS = 24e6; // canvas size cap
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const stage = $("#stage");
const pagesEl = $("#pages");
const scratch = $("#scratch");

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */
// Dark themes invert the page bitmap with a CSS filter. Light themes keep it
// as is and multiply it over a tinted page background. `page` and `ink` are
// the resulting paper and text colors, used for the swatches and as the
// background shown before a page has rendered.

const THEMES = [
  { id: "original", name: "Original", dark: false, page: "#ffffff", ink: "#000000", stage: "#525659" },
  { id: "paper", name: "Paper", dark: false, blend: true, page: "#f3eedf", ink: "#1a1a1a", stage: "#58585a" },
  { id: "sand", name: "Sand", dark: false, blend: true, page: "#e7d8b9", ink: "#1a1a1a", stage: "#585550" },
  { id: "mist", name: "Mist", dark: false, blend: true, page: "#e3e8ec", ink: "#1a1a1a", stage: "#55595d" },

  { id: "classic", name: "Classic", dark: true, filter: "invert(.82) sepia(.13) saturate(.70) hue-rotate(345deg)", page: "#302f2e", ink: "#dbd6d3", stage: "#232322" },
  { id: "warm", name: "Warm", dark: true, filter: "invert(.84) sepia(.30) saturate(.72) hue-rotate(342deg)", page: "#2d2b29", ink: "#eee2da", stage: "#211f1e" },
  { id: "sepia", name: "Sepia", dark: true, filter: "invert(.78) sepia(.48) saturate(.72) hue-rotate(350deg)", page: "#413d39", ink: "#e8d9ca", stage: "#2e2a27" },
  { id: "blue", name: "Blue", dark: true, filter: "invert(.84) sepia(.22) saturate(.80) hue-rotate(175deg)", page: "#2a2b2d", ink: "#dae1ea", stage: "#1e1f21" },
  { id: "green", name: "Green", dark: true, filter: "invert(.84) sepia(.28) saturate(.70) hue-rotate(65deg)", page: "#2a2c29", ink: "#dbe7d9", stage: "#1e201e" },
  { id: "night", name: "Night", dark: true, filter: "invert(.9) hue-rotate(180deg)", page: "#191919", ink: "#e5e6e5", stage: "#0f0f0f" },
  { id: "midnight", name: "Midnight", dark: true, filter: "invert(.9) sepia(.6) saturate(1.6) hue-rotate(190deg)", page: "#1b1d24", ink: "#e6e4f4", stage: "#101218" },
  { id: "solarized", name: "Solarized", dark: true, filter: "invert(.88) sepia(.7) saturate(1.3) hue-rotate(130deg)", page: "#1b2525", ink: "#c4e8e4", stage: "#101818" },
  { id: "dusk", name: "Dusk", dark: true, filter: "invert(.9) sepia(.6) saturate(1.5) hue-rotate(240deg)", page: "#211b23", ink: "#eddcef", stage: "#151118" },
  { id: "amber", name: "Amber", dark: true, filter: "invert(.9) sepia(1) saturate(2.2) hue-rotate(-12deg)", page: "#2a1d11", ink: "#f4d9a0", stage: "#1b120a" },
  { id: "oled", name: "OLED", dark: true, filter: "invert(.93) hue-rotate(180deg)", page: "#121212", ink: "#ededed", stage: "#000000" },
];

const state = {
  theme: lsGet("theme", "classic"),
  brightness: +lsGet("brightness", 100),
  contrast: +lsGet("contrast", 100),
  preserveImages: lsGet("preserveImages", "true") !== "false",
  spread: lsGet("spread", "none"),
  matchCase: lsGet("matchCase", "false") === "true",
  dblTranslate: lsGet("dblTranslate", "true") !== "false",
  trLang: lsGet("trLang", ""),
  hlColor: lsGet("hlColor", "yellow"),
};
if (!THEMES.some((t) => t.id === state.theme)) state.theme = "classic";
if (!["none", "odd", "even"].includes(state.spread)) state.spread = "none";

const currentTheme = () => THEMES.find((t) => t.id === state.theme);
const needKeepLayers = () => state.preserveImages && currentTheme().dark;

function buildThemeList() {
  const list = $("#themeList");
  list.replaceChildren();
  for (const [label, dark] of [["Light", false], ["Dark", true]]) {
    const h = document.createElement("div");
    h.className = "group-label";
    h.textContent = label;
    list.append(h);
    for (const t of THEMES.filter((x) => x.dark === dark)) {
      const b = document.createElement("button");
      b.className = "theme-btn";
      b.dataset.theme = t.id;
      b.innerHTML = `<i style="background:${t.page};color:${t.ink}">Aa</i><span>${t.name}</span>`;
      b.onclick = () => {
        state.theme = t.id;
        applyTheme();
      };
      list.append(b);
    }
  }
}

function applyTheme() {
  const t = currentTheme();
  const root = document.documentElement.style;
  const parts = [];
  if (t.filter) parts.push(t.filter);
  if (state.brightness !== 100) parts.push(`brightness(${state.brightness / 100})`);
  if (state.contrast !== 100) parts.push(`contrast(${state.contrast / 100})`);

  root.setProperty("--page-filter", parts.join(" ") || "none");
  root.setProperty("--page-blend", t.blend ? "multiply" : "normal");
  root.setProperty("--page-bg", t.page);
  root.setProperty("--stage-bg", t.stage);

  $$(".theme-btn").forEach((b) => b.classList.toggle("active", b.dataset.theme === t.id));
  $("#brightness").value = state.brightness;
  $("#contrast").value = state.contrast;
  $("#preserveImages").checked = state.preserveImages;

  lsSet("theme", state.theme);
  lsSet("brightness", state.brightness);
  lsSet("contrast", state.contrast);
  lsSet("preserveImages", state.preserveImages);

  rebuildKeepLayers();
}

/* ------------------------------------------------------------------ */
/* Document state                                                      */
/* ------------------------------------------------------------------ */

let pdf = null;
let docGen = 0;
let docKey = null; // stable key used to remember the reading position
let docName = "document.pdf";
let docSource = null; // original URL, if any

let scale = 1;
let zoomMode = "auto"; // auto | page | width | actual | custom
let rotation = 0; // user rotation, degrees
let current = 1;

let sizes = []; // sizes[n] = { w, h } at scale 1 (page's own rotation included)
let pages = []; // pages[n] = page record, 1-based
let rows = []; // rows of page numbers
let blanks = [];
let io = null;
let sizeDirty = false;

const visible = new Set();
const queue = new Set();
let active = 0;
let renderTimer = 0;

const keyNow = () => `${scale.toFixed(4)}|${rotation}`;

function baseSize(n) {
  return sizes[n] || sizes[1] || { w: 612, h: 792 };
}
function dims(n) {
  const b = baseSize(n);
  const swap = rotation % 180 !== 0;
  return {
    w: Math.round((swap ? b.h : b.w) * scale),
    h: Math.round((swap ? b.w : b.h) * scale),
  };
}
function eachPage(fn) {
  for (let n = 1; n < pages.length; n++) if (pages[n]) fn(pages[n]);
}

function toast(msg, ms = 1800) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => el.classList.remove("show"), ms);
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildPages() {
  io?.disconnect();
  visible.clear();
  queue.clear();
  pagesEl.replaceChildren();
  pages = [undefined];
  rows = [];
  blanks = [];

  const N = pdf.numPages;
  const make = (n) => {
    const el = document.createElement("section");
    el.className = "page";
    el.dataset.page = n;
    pages[n] = {
      num: n, el, row: 0, state: "empty", ver: 0, key: "", renderKey: "",
      task: null, canvas: null, textDivs: null, imgRects: null, links: [], retries: 0,
      renderScale: 0, renderRot: 0, marked: new Set(),
    };
    return pages[n];
  };

  const addRow = (nums, blankFirst = false) => {
    const row = document.createElement("div");
    row.className = "spread";
    if (blankFirst) {
      const b = document.createElement("div");
      b.className = "blank";
      blanks.push(b);
      row.append(b);
    }
    for (const n of nums) {
      const p = make(n);
      p.row = rows.length;
      row.append(p.el);
    }
    rows.push(nums);
    pagesEl.append(row);
  };

  if (state.spread === "none") {
    for (let n = 1; n <= N; n++) addRow([n]);
  } else {
    let n = 1;
    if (state.spread === "even") {
      addRow([1], true);
      n = 2;
    }
    for (; n <= N; n += 2) addRow(n + 1 <= N ? [n, n + 1] : [n]);
  }

  $("#pageCount").textContent = N;
  layout();

  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = +e.target.dataset.page;
        if (e.isIntersecting) visible.add(n);
        else visible.delete(n);
      }
      onScroll();
      scheduleRender();
    },
    { root: stage, rootMargin: "600px 0px" }
  );
  eachPage((p) => io.observe(p.el));
}

function layout() {
  const k = keyNow();
  eachPage((p) => {
    const d = dims(p.num);
    p.el.style.width = d.w + "px";
    p.el.style.height = d.h + "px";
    if (p.state === "ok") p.el.classList.toggle("stale", p.key !== k);
  });
  const first = dims(1);
  for (const b of blanks) {
    b.style.width = first.w + "px";
    b.style.height = first.h + "px";
  }
}

// Run fn (which changes the layout) and keep the point at (cx, cy), measured
// from the top-left of the visible area, in the same place on screen.
function withAnchor(cx, cy, fn) {
  if (!pdf || !pages[current]) return fn();
  const sr = stage.getBoundingClientRect();
  if (cx == null) {
    cx = stage.clientWidth / 2;
    cy = stage.clientHeight / 2;
  }
  const py = sr.top + cy;
  let ref = pages[current];
  let best = Infinity;
  for (let n = Math.max(1, current - 3); n <= Math.min(pdf.numPages, current + 3); n++) {
    const r = pages[n].el.getBoundingClientRect();
    const d = py < r.top ? r.top - py : py > r.bottom ? py - r.bottom : 0;
    if (d < best) {
      best = d;
      ref = pages[n];
    }
  }
  const r0 = ref.el.getBoundingClientRect();
  const fy = r0.height ? (py - r0.top) / r0.height : 0;
  const fx = r0.width ? (sr.left + cx - r0.left) / r0.width : 0;

  fn();

  const r1 = ref.el.getBoundingClientRect();
  stage.scrollTop += r1.top + fy * r1.height - py;
  stage.scrollLeft += r1.left + fx * r1.width - (sr.left + cx);
}

function relayoutKeepingPosition() {
  const p = pages[current];
  if (!p) return layout();
  const before = p.el.getBoundingClientRect().top;
  layout();
  stage.scrollTop += p.el.getBoundingClientRect().top - before;
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

function fitScale(mode) {
  if (mode === "actual") return 1;
  const b = baseSize(current);
  const swap = rotation % 180 !== 0;
  const w = swap ? b.h : b.w;
  const h = swap ? b.w : b.h;
  const cols = state.spread === "none" ? 1 : 2;
  const availW = Math.max(100, stage.clientWidth - PAD * 2 - (cols - 1) * GAP);
  const availH = Math.max(100, stage.clientHeight - PAD * 2);
  const byWidth = availW / (w * cols);
  const byHeight = availH / h;
  if (mode === "width") return byWidth;
  if (mode === "page") return Math.min(byWidth, byHeight);
  return Math.min(byWidth, 1.25); // auto
}

function setScale(s, mode = "custom", cx, cy, delay = 0) {
  if (!pdf) return;
  s = clamp(s, MIN_SCALE, MAX_SCALE);
  zoomMode = mode;
  if (Math.abs(s - scale) > 1e-4) {
    withAnchor(cx, cy, () => {
      scale = s;
      layout();
    });
    scheduleRender(delay);
  }
  updateZoomUI();
  saveViewSoon();
}

function setZoomMode(m) {
  if (["auto", "page", "width", "actual"].includes(m)) setScale(fitScale(m), m);
  else setScale(+m / 100, "custom");
}

function stepZoom(dir, cx, cy) {
  let target;
  if (dir > 0) target = ZOOM_STEPS.find((z) => z > scale + 0.005) ?? MAX_SCALE;
  else target = [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.005) ?? MIN_SCALE;
  setScale(target, "custom", cx, cy);
}

function updateZoomUI() {
  const sel = $("#zoomSelect");
  const pct = Math.round(scale * 100);
  if (zoomMode !== "custom") {
    sel.value = zoomMode;
  } else {
    const preset = [...sel.options].find((o) => o.value === String(pct));
    if (preset) sel.value = preset.value;
    else {
      $("#zoomCustom").textContent = pct + "%";
      sel.value = "custom";
    }
  }
  sel.title = pct + "%";
}

function stageCoords(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return [clamp(clientX - r.left, 0, stage.clientWidth), clamp(clientY - r.top, 0, stage.clientHeight)];
}

/* ------------------------------------------------------------------ */
/* Rotation, page layout                                               */
/* ------------------------------------------------------------------ */

function rotate(dir = 1) {
  if (!pdf) return;
  const n = current;
  rotation = (rotation + 90 * dir + 360) % 360;
  // The old bitmaps would just be stretched into the wrong shape, so drop them.
  eachPage(unloadPage);
  if (zoomMode !== "custom") scale = clamp(fitScale(zoomMode), MIN_SCALE, MAX_SCALE);
  layout();
  updateZoomUI();
  go(n, "auto");
  buildThumbnails();
  scheduleRender();
  saveViewSoon();
}

function rebuildAll(n) {
  eachPage(unloadPage);
  buildPages();
  if (zoomMode !== "custom") scale = clamp(fitScale(zoomMode), MIN_SCALE, MAX_SCALE);
  layout();
  updateZoomUI();
  go(n, "auto");
  buildThumbnails();
}

function setSpread(mode) {
  state.spread = mode;
  lsSet("spread", mode);
  if (pdf) rebuildAll(current);
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function setCurrent(n) {
  current = n;
  const input = $("#pageNumber");
  if (document.activeElement !== input) input.value = n;
  $$(".thumb-item").forEach((t) => t.classList.toggle("current", +t.dataset.page === n));
  if (!$("#thumbPanel").hidden && !$("#sidebar").hidden) {
    $(`.thumb-item[data-page="${n}"]`)?.scrollIntoView({ block: "nearest" });
  }
  saveViewSoon();
}

let scrollQueued = false;
function onScroll() {
  if (scrollQueued || !pdf) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const sr = stage.getBoundingClientRect();
    let best = 0;
    let bestArea = -1;
    for (const n of visible) {
      const r = pages[n]?.el.getBoundingClientRect();
      if (!r) continue;
      const area = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
      if (area > bestArea + 1 || (Math.abs(area - bestArea) <= 1 && n < best)) {
        best = n;
        bestArea = area;
      }
    }
    if (best && best !== current) setCurrent(best);
  });
}

// yPdf: optional y coordinate (PDF user space) to land on inside the page.
function go(n, behavior = "smooth", yPdf = null) {
  if (!pdf) return;
  n = clamp(Math.round(n) || 1, 1, pdf.numPages);
  const p = pages[n];
  if (!p) return;
  setCurrent(n);
  const sr = stage.getBoundingClientRect();
  const r = p.el.getBoundingClientRect();
  let top = stage.scrollTop + r.top - sr.top - PAD;
  if (yPdf != null && rotation === 0) top += Math.max(0, (baseSize(n).h - yPdf) * scale - 8);
  stage.scrollTo({ top: Math.max(0, top), left: stage.scrollLeft, behavior });
  scheduleRender();
}

function stepPage(dir) {
  const p = pages[current];
  if (!p) return;
  const row = rows[clamp(p.row + dir, 0, rows.length - 1)];
  go(row[0], "smooth");
}

async function goDest(dest) {
  try {
    if (typeof dest === "string") dest = await pdf.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const ref = dest[0];
    const index = typeof ref === "object" && ref !== null ? await pdf.getPageIndex(ref) : +ref;
    const kind = dest[1]?.name;
    let y = null;
    if (kind === "XYZ" && typeof dest[3] === "number") y = dest[3];
    else if ((kind === "FitH" || kind === "FitBH") && typeof dest[2] === "number") y = dest[2];
    go(index + 1, "auto", y);
  } catch {
    toast("Could not follow that link");
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function scheduleRender(delay = 0) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(refresh, delay);
}

function refresh() {
  if (!pdf) return;
  const k = keyNow();
  const want = [...visible].sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
  for (const n of want) {
    const p = pages[n];
    if (!p) continue;
    if (p.state === "loading" && p.renderKey !== k) {
      // Rendering at an outdated zoom: abandon it and start over.
      p.task?.cancel();
      p.ver++;
      p.state = "empty";
    }
    if (p.state === "empty" || (p.state === "ok" && p.key !== k)) queue.add(n);
  }
  pump();
}

function pump() {
  while (active < 2 && queue.size) {
    let best = -1;
    let bestD = Infinity;
    for (const n of queue) {
      const d = Math.abs(n - current);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    queue.delete(best);
    const p = pages[best];
    if (!p || !visible.has(best) || p.state === "loading") continue;
    if (p.state === "ok" && p.key === keyNow()) continue;
    active++;
    renderPage(p)
      .catch((e) => console.error("Render failed for page", best, e))
      .finally(() => {
        active--;
        pump();
      });
  }
}

function unloadPage(p) {
  p.ver++;
  p.task?.cancel();
  p.task = null;
  p.state = "empty";
  p.canvas = null;
  p.textDivs = null;
  p.imgRects = null;
  p.links = [];
  p.marked.clear();
  p.el.replaceChildren();
  p.el.classList.remove("ready", "stale");
}

function evict() {
  const live = pages.filter((p) => p && p.state === "ok");
  if (live.length <= MAX_LIVE_PAGES) return;
  live.sort((a, b) => Math.abs(b.num - current) - Math.abs(a.num - current));
  let count = live.length;
  for (const p of live) {
    if (count <= MAX_LIVE_PAGES) break;
    if (visible.has(p.num)) continue;
    unloadPage(p);
    count--;
  }
}

function noteSize(n, page) {
  const v = page.getViewport({ scale: 1 });
  const prev = sizes[n];
  sizes[n] = { w: v.width, h: v.height };
  if (!prev || Math.abs(prev.w - v.width) > 0.5 || Math.abs(prev.h - v.height) > 0.5) sizeDirty = true;
}

async function renderPage(p) {
  const ver = p.ver;
  const k = keyNow();
  const sc = scale;
  const userRot = rotation;
  p.state = "loading";
  p.renderKey = k;

  try {
    const page = await pdf.getPage(p.num);
    if (ver !== p.ver) return;
    noteSize(p.num, page);

    const viewport = page.getViewport({ scale: sc, rotation: (page.rotate + userRot) % 360 });

    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (viewport.width * viewport.height * dpr * dpr > MAX_PIXELS) {
      dpr = Math.max(0.5, Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)));
    }

    const canvas = document.createElement("canvas");
    canvas.className = "pdfCanvas";
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const task = page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    }
    p.task = null;
    if (ver !== p.ver) return;

    // Text layer is built off-screen so the old one stays until this one is ready.
    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    textLayerEl.style.setProperty("--total-scale-factor", viewport.scale);
    textLayerEl.style.setProperty("--scale-round-x", "1px");
    textLayerEl.style.setProperty("--scale-round-y", "1px");
    scratch.append(textLayerEl);

    let textDivs = [];
    try {
      const layer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerEl,
        viewport,
      });
      await layer.render();
      textDivs = layer.textDivs;
    } catch (err) {
      console.warn("Text layer failed on page", p.num, err);
    }
    if (ver !== p.ver) {
      textLayerEl.remove();
      return;
    }

    const links = await loadLinks(page, viewport);
    if (ver !== p.ver) {
      textLayerEl.remove();
      return;
    }

    p.el.replaceChildren(canvas, textLayerEl);
    p.links = links;
    p.retries = 0;
    delete p.el.dataset.error;
    p.el.classList.add("ready");
    p.canvas = canvas;
    p.textDivs = textDivs;
    p.imgRects = null;
    p.renderScale = sc;
    p.renderRot = (page.rotate + userRot) % 360;
    p.key = k;
    p.state = "ok";
    p.el.classList.toggle("stale", k !== keyNow());

    if (needKeepLayers()) buildKeepLayers(p);
    drawHighlights(p);
    if (search.q) highlightPage(p);

    evict();
    if (sizeDirty) {
      sizeDirty = false;
      relayoutKeepingPosition();
    }
    if (k !== keyNow()) scheduleRender();
  } catch (err) {
    if (ver === p.ver) {
      p.state = "empty";
      p.retries = (p.retries || 0) + 1;
      if (p.retries <= 2) setTimeout(() => scheduleRender(), 700);
      else p.el.dataset.error = "Could not render this page: " + (err?.message || err);
    }
    throw err;
  }
}

// Links are kept as data (fractions of the page) and hit-tested on mouse events
// instead of being separate elements, so no other layer can cover them.
async function loadLinks(page, viewport) {
  try {
    const list = await page.getAnnotations({ intent: "display" });
    const out = [];
    for (const a of list) {
      if (a.subtype !== "Link" || !a.rect) continue;
      if (!(a.url || a.unsafeUrl || a.dest || a.action)) continue;
      const [ax, ay] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [bx, by] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
      const r = [ax, ay, bx, by];
      out.push({
        x: Math.min(r[0], r[2]) / viewport.width,
        y: Math.min(r[1], r[3]) / viewport.height,
        w: Math.abs(r[2] - r[0]) / viewport.width,
        h: Math.abs(r[3] - r[1]) / viewport.height,
        dest: a.dest,
        url: a.url || a.unsafeUrl,
        action: a.action,
      });
    }
    return out;
  } catch (err) {
    console.warn("Could not read links on a page", err);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Keeping images in their original colors on dark themes              */
/* ------------------------------------------------------------------ */
// The page bitmap is filtered as a whole, so photos would be inverted too.
// To avoid that, find where the page paints images and lay an unfiltered copy
// of just those regions over the filtered bitmap.

async function findImageRects(page, viewport) {
  const { OPS, Util } = pdfjsLib;
  const list = await page.getOperatorList();
  const rects = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const pageArea = viewport.width * viewport.height;

  const addImage = () => {
    const m = Util.transform(viewport.transform, ctm);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => {
      Util.applyTransform(p, m); // transforms in place
      return p;
    });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    const w = Math.min(viewport.width, Math.max(...xs)) - x;
    const h = Math.min(viewport.height, Math.max(...ys)) - y;
    // Skip specks (rules, bullets) and full-page scans, which should be themed.
    if (w < 24 || h < 24 || w * h > pageArea * 0.8) return;
    rects.push({ x, y, w, h });
  };

  for (let i = 0; i < list.fnArray.length && rects.length < 40; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(ctm);
        break;
      case OPS.restore:
      case OPS.endGroup:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args?.[0]) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        addImage();
        break;
    }
  }
  return rects;
}

async function buildKeepLayers(p) {
  const ver = p.ver;
  try {
    if (!p.imgRects) {
      const page = await pdf.getPage(p.num);
      if (ver !== p.ver) return;
      const vp = page.getViewport({ scale: p.renderScale, rotation: p.renderRot });
      p.imgRects = await findImageRects(page, vp);
      if (ver !== p.ver) return;
    }
    removeKeepLayers(p);
    if (!needKeepLayers() || !p.canvas) return;
    const ratio = p.canvas.width / (p.el.clientWidth || 1);
    for (const r of p.imgRects) {
      const c = document.createElement("canvas");
      c.className = "keep";
      c.width = Math.max(1, Math.round(r.w * ratio));
      c.height = Math.max(1, Math.round(r.h * ratio));
      c.style.left = r.x + "px";
      c.style.top = r.y + "px";
      c.style.width = r.w + "px";
      c.style.height = r.h + "px";
      c.getContext("2d").drawImage(p.canvas, r.x * ratio, r.y * ratio, r.w * ratio, r.h * ratio, 0, 0, c.width, c.height);
      p.el.insertBefore(c, p.el.querySelector(".textLayer"));
    }
  } catch (err) {
    console.warn("Image preservation skipped on page", p.num, err);
  }
}

function removeKeepLayers(p) {
  $$(".keep", p.el).forEach((c) => c.remove());
}

function rebuildKeepLayers() {
  eachPage((p) => {
    if (p.state !== "ok") return;
    if (needKeepLayers()) buildKeepLayers(p);
    else removeKeepLayers(p);
  });
  // Thumbnails follow the theme through CSS, nothing to do for them.
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const search = { q: "", token: 0, hits: [], cur: -1, pending: null, scanning: false };
const itemCache = new Map();
let findTimer = 0;

async function getItems(n) {
  if (itemCache.has(n)) return itemCache.get(n);
  const page = await pdf.getPage(n);
  const content = await page.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (typeof it.str === "string") items.push({ str: it.str, eol: !!it.hasEOL });
  }
  itemCache.set(n, items);
  return items;
}

function updateFindStatus() {
  const el = $("#findStatus");
  if (!search.q) {
    el.textContent = "";
  } else if (!search.hits.length) {
    el.textContent = search.scanning ? "Searching…" : "No results";
  } else {
    el.textContent = `${search.cur + 1} of ${search.hits.length}${search.scanning ? "+" : ""}`;
  }
}

function openFind() {
  closePopups();
  const bar = $("#findbar");
  bar.hidden = false;
  $("#searchButton").classList.add("on");
  const input = $("#findInput");
  const sel = String(window.getSelection() || "").trim();
  if (sel && sel.length < 80 && !sel.includes("\n")) input.value = sel;
  input.focus();
  input.select();
  runSearch();
}

function closeFind() {
  $("#findbar").hidden = true;
  $("#searchButton").classList.remove("on");
  clearTimeout(findTimer);
  search.token++;
  search.q = "";
  search.hits = [];
  search.cur = -1;
  search.pending = null;
  search.scanning = false;
  eachPage(clearMarks);
  updateFindStatus();
  stage.focus({ preventScroll: true });
}

const toggleFind = () => ($("#findbar").hidden ? openFind() : closeFind());

async function runSearch() {
  const token = ++search.token;
  const q = normalizeQuery($("#findInput").value, state.matchCase);
  search.q = q;
  search.hits = [];
  search.cur = -1;
  search.pending = null;
  eachPage(clearMarks);

  if (!q || !pdf) {
    search.scanning = false;
    updateFindStatus();
    return;
  }

  search.scanning = true;
  updateFindStatus();
  eachPage((p) => p.state === "ok" && highlightPage(p));

  const start = current;
  let navigated = false;

  for (let n = 1; n <= pdf.numPages; n++) {
    if (token !== search.token) return;
    const idx = buildIndex(await getItems(n), state.matchCase);
    const found = findAll(idx, q);
    if (found.length) {
      const first = search.hits.length;
      found.forEach((_, k) => search.hits.push({ page: n, k }));
      if (!navigated && n >= start) {
        navigated = true;
        search.cur = first;
        revealHit();
      }
    }
    if (n % 6 === 0) {
      updateFindStatus();
      await tick();
    }
  }
  if (token !== search.token) return;

  search.scanning = false;
  if (!navigated && search.hits.length) {
    search.cur = 0;
    revealHit();
  }
  updateFindStatus();
}

function stepHit(dir) {
  if (!search.hits.length) return;
  search.cur = (search.cur + dir + search.hits.length) % search.hits.length;
  revealHit();
}

function revealHit() {
  updateFindStatus();
  const hit = search.hits[search.cur];
  if (!hit) return;
  search.pending = hit;
  setActiveMarks();
  const p = pages[hit.page];
  if (!p || !scrollToActive(p)) go(hit.page, "auto");
}

function scrollToActive(p) {
  const mark = p.el.querySelector("mark.hit.active");
  if (!mark) return false;
  const sr = stage.getBoundingClientRect();
  const r = mark.getBoundingClientRect();
  stage.scrollTo({
    top: stage.scrollTop + r.top + r.height / 2 - (sr.top + stage.clientHeight / 2),
    left: stage.scrollLeft + r.left + r.width / 2 - (sr.left + stage.clientWidth / 2),
    behavior: "auto",
  });
  if (search.pending?.page === p.num) search.pending = null;
  return true;
}

function setActiveMarks() {
  const hit = search.hits[search.cur];
  eachPage((p) => {
    if (p.state !== "ok") return;
    $$("mark.hit", p.el).forEach((m) => {
      m.classList.toggle("active", !!hit && p.num === hit.page && +m.dataset.k === hit.k);
    });
  });
}

function clearMarks(p) {
  for (const div of p.marked) {
    if (div._orig !== undefined) div.textContent = div._orig;
  }
  p.marked.clear();
}

async function highlightPage(p) {
  const ver = p.ver;
  const token = search.token;
  clearMarks(p);
  if (!search.q || !p.textDivs) return;

  let items = await getItems(p.num);
  if (ver !== p.ver || token !== search.token || p.state !== "ok") return;
  if (items.length !== p.textDivs.length) {
    // Should not happen; fall back to what the text layer itself holds.
    items = p.textDivs.map((d) => ({ str: d.textContent, eol: false }));
  }

  const idx = buildIndex(items, state.matchCase);
  const found = findAll(idx, search.q);
  const byItem = new Map();
  found.forEach((m, k) => {
    for (const [item, ranges] of rangesFor(idx, m)) {
      if (!byItem.has(item)) byItem.set(item, []);
      for (const [s, e] of ranges) byItem.get(item).push({ s, e, k });
    }
  });

  for (const [item, list] of byItem) {
    const div = p.textDivs[item];
    if (!div || !div.isConnected) continue;
    const text = div.textContent;
    const frag = document.createDocumentFragment();
    let pos = 0;
    list.sort((a, b) => a.s - b.s);
    for (const { s, e, k } of list) {
      if (s < pos || e <= s) continue;
      if (s > pos) frag.append(text.slice(pos, s));
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.dataset.k = k;
      mark.textContent = text.slice(s, e);
      frag.append(mark);
      pos = e;
    }
    if (pos < text.length) frag.append(text.slice(pos));
    div._orig = text;
    div.replaceChildren(frag);
    p.marked.add(div);
  }

  setActiveMarks();
  if (search.pending?.page === p.num) scrollToActive(p);
}

/* ------------------------------------------------------------------ */
/* Sidebar: contents, thumbnails, info                                 */
/* ------------------------------------------------------------------ */

async function buildOutline() {
  const panel = $("#outlinePanel");
  panel.replaceChildren();
  let outline = [];
  try {
    outline = (await pdf.getOutline()) || [];
  } catch {}
  if (!outline.length) {
    panel.innerHTML = '<div class="empty-side">This PDF has no table of contents.</div>';
    return;
  }
  const add = (items, level) => {
    for (const item of items) {
      const b = document.createElement("button");
      b.className = "outline-item";
      b.textContent = item.title || "Untitled";
      b.style.paddingLeft = 8 + level * 14 + "px";
      b.onclick = () => {
        if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
        else if (item.dest) goDest(item.dest);
      };
      panel.append(b);
      if (item.items?.length) add(item.items, level + 1);
    }
  };
  add(outline, 0);
}

let thumbObserver = null;

function buildThumbnails() {
  const panel = $("#thumbPanel");
  thumbObserver?.disconnect();
  panel.replaceChildren();
  if (!pdf) return;

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        renderThumbnail(+e.target.dataset.page).catch(() => {});
      }
    },
    { root: panel, rootMargin: "300px" }
  );

  const swap = rotation % 180 !== 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    const b = baseSize(n);
    const item = document.createElement("button");
    item.className = "thumb-item";
    item.dataset.page = n;
    item.innerHTML = `<div class="thumb-page" style="aspect-ratio:${swap ? b.h : b.w} / ${swap ? b.w : b.h}"></div><b>${n}</b>`;
    item.onclick = () => go(n, "auto");
    if (n === current) item.classList.add("current");
    panel.append(item);
    thumbObserver.observe(item);
  }
}

async function renderThumbnail(n) {
  const item = $(`.thumb-item[data-page="${n}"]`);
  if (!item || item.dataset.done || !pdf) return;
  const doc = pdf;
  const page = await doc.getPage(n);
  if (doc !== pdf) return;
  const rot = (page.rotate + rotation) % 360;
  const base = page.getViewport({ scale: 1, rotation: rot });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (220 * dpr) / base.width, rotation: rot });
  const canvas = document.createElement("canvas");
  canvas.className = "thumb-canvas";
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  if (doc !== pdf) return;
  item.dataset.done = "1";
  $(".thumb-page", item).replaceChildren(canvas);
}

async function buildInfo() {
  let info = {};
  let length = 0;
  try {
    info = (await pdf.getMetadata())?.info || {};
  } catch {}
  try {
    length = (await pdf.getDownloadInfo())?.length || 0;
  } catch {}
  const b = baseSize(1);
  const fmtDate = (s) => {
    const m = /D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s || "");
    return m ? `${m[1]}-${m[2] || "01"}-${m[3] || "01"}${m[4] ? ` ${m[4]}:${m[5] || "00"}` : ""}` : "";
  };
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  const rowsData = [
    ["Title", info.Title || document.title],
    ["Author", info.Author],
    ["Subject", info.Subject],
    ["Keywords", info.Keywords],
    ["Created", fmtDate(info.CreationDate)],
    ["Modified", fmtDate(info.ModDate)],
    ["Creator", info.Creator],
    ["Producer", info.Producer],
    ["PDF version", info.PDFFormatVersion],
    ["Pages", pdf.numPages],
    ["Page size", `${mm(b.w)} × ${mm(b.h)} mm`],
    ["File size", length ? (length / 1048576 >= 1 ? (length / 1048576).toFixed(1) + " MB" : Math.round(length / 1024) + " KB") : ""],
  ].filter(([, v]) => v !== undefined && v !== "");
  const panel = $("#infoPanel");
  panel.replaceChildren();
  for (const [k, v] of rowsData) {
    const row = document.createElement("div");
    row.className = "info-row";
    const a = document.createElement("span");
    const c = document.createElement("strong");
    a.textContent = k;
    c.textContent = String(v);
    row.append(a, c);
    panel.append(row);
  }
}

function toggleSidebar(force) {
  const sb = $("#sidebar");
  const open = force ?? sb.hidden;
  sb.hidden = !open;
  document.body.classList.toggle("sidebar-open", open);
  $("#sidebarToggle").classList.toggle("on", open);
  if (open) $(`.thumb-item[data-page="${current}"]`)?.scrollIntoView({ block: "nearest" });
}

function showSideTab(panelId) {
  $$(".side-tab").forEach((t) => t.classList.toggle("active", t.dataset.panel === panelId));
  $$(".side-panel").forEach((p) => (p.hidden = p.id !== panelId));
}

/* ------------------------------------------------------------------ */
/* Menus, fullscreen                                                   */
/* ------------------------------------------------------------------ */

function closePopups() {
  $("#moreMenu").hidden = true;
  $("#themePanel").hidden = true;
  $("#moreButton").classList.remove("on");
  $("#themeButton").classList.remove("on");
}

function togglePopup(id, button) {
  const el = $(id);
  const open = el.hidden;
  closePopups();
  el.hidden = !open;
  $(button).classList.toggle("on", open);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("Fullscreen is not available");
  }
}

/* ------------------------------------------------------------------ */
/* Opening, saving, printing                                           */
/* ------------------------------------------------------------------ */

function parseSrc() {
  const m = location.search.match(/[?&]src=(.*)$/);
  if (!m) return null;
  let v = m[1];
  if (/^(https?|file|ftp|blob|data)%3A/i.test(v)) {
    try {
      v = decodeURIComponent(v);
    } catch {}
  }
  return v;
}

function nameFromUrl(value) {
  try {
    const clean = decodeURIComponent(value.split("#")[0].split("?")[0]);
    return clean.split("/").pop() || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function setLoading(text, isError = false) {
  const el = $("#loading");
  el.classList.remove("hidden");
  el.replaceChildren();
  if (!isError) {
    const s = document.createElement("div");
    s.className = "spinner";
    el.append(s);
  }
  const t = document.createElement("span");
  t.id = "loadingText";
  t.textContent = text;
  el.append(t);
}

async function closeDocument() {
  await flushNotes();
  hideFloaters();
  notes = [];
  renderNotesPanel();
  docGen++;
  clearTimeout(findTimer);
  search.token++;
  search.q = "";
  search.hits = [];
  search.cur = -1;
  itemCache.clear();
  io?.disconnect();
  thumbObserver?.disconnect();
  visible.clear();
  queue.clear();
  eachPage((p) => p.task?.cancel());
  pages = [undefined];
  pagesEl.replaceChildren();
  const old = pdf;
  pdf = null;
  sizes = [];
  if (old) {
    try {
      await old.destroy();
    } catch {}
  }
}

async function openDocument(source, { name, key, src, page }) {
  await closeDocument();
  const gen = docGen;
  docName = name;
  docKey = key;
  docSource = src || null;
  $("#welcome").hidden = true;
  setLoading("Opening PDF…");

  try {
    const task = pdfjsLib.getDocument({
      ...source,
      cMapUrl: asset("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: asset("standard_fonts/"),
      wasmUrl: asset("wasm/"),
    });
    task.onProgress = ({ loaded, total }) => {
      const t = $("#loadingText");
      if (!t || gen !== docGen) return;
      t.textContent = total ? `Opening PDF… ${Math.round((loaded / total) * 100)}%` : `Opening PDF… ${(loaded / 1048576).toFixed(1)} MB`;
    };
    task.onPassword = (reply, reason) => {
      const again = reason === pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD;
      const pw = window.prompt(again ? "Wrong password. Try again:" : "This PDF is password protected. Enter the password:");
      if (pw === null) task.destroy();
      else reply(pw);
    };

    const doc = await task.promise;
    if (gen !== docGen) {
      doc.destroy();
      return;
    }
    pdf = doc;

    const first = await pdf.getPage(1);
    noteSize(1, first);
    sizeDirty = false;

    await setDocumentTitle();

    const saved = loadView();
    rotation = saved?.rotation || 0;
    zoomMode = saved?.zoom || "auto";
    current = 1;
    scale = zoomMode === "custom" ? clamp(saved.scale || 1, MIN_SCALE, MAX_SCALE) : clamp(fitScale(zoomMode), MIN_SCALE, MAX_SCALE);
    if (!["auto", "page", "width", "actual", "custom"].includes(zoomMode)) zoomMode = "auto";

    buildPages();
    updateZoomUI();
    $("#loading").classList.add("hidden");

    const startPage = clamp(page || saved?.page || 1, 1, pdf.numPages);
    go(startPage, "auto");
    stage.focus({ preventScroll: true });

    buildOutline();
    buildThumbnails();
    buildInfo();
    loadAllSizes(gen);
    loadNotes(gen);
    checkAssets();
  } catch (err) {
    if (gen !== docGen) return;
    console.error(err);
    let msg = err?.message || "PDF.js could not load this document.";
    if (docSource?.startsWith("file:")) msg += " For local files, turn on “Allow access to file URLs” for this extension in chrome://extensions.";
    setLoading(msg, true);
  }
}

// Page sizes are only known once a page has been fetched. Read them all in the
// background so documents with mixed page sizes lay out correctly.
async function loadAllSizes(gen) {
  const N = pdf.numPages;
  if (N > 3000) return;
  let changed = false;
  for (let n = 2; n <= N; n++) {
    if (gen !== docGen) return;
    if (sizes[n]) continue;
    try {
      const page = await pdf.getPage(n);
      if (gen !== docGen) return;
      const v = page.getViewport({ scale: 1 });
      const base = baseSize(1);
      if (Math.abs(v.width - base.w) > 0.5 || Math.abs(v.height - base.h) > 0.5) changed = true;
      sizes[n] = { w: v.width, h: v.height };
    } catch {}
    if (n % 25 === 0) await tick();
  }
  if (gen === docGen && changed) {
    relayoutKeepingPosition();
    buildThumbnails();
    scheduleRender();
  }
}

async function setDocumentTitle() {
  let title = "";
  try {
    const meta = await pdf.getMetadata();
    const t = meta?.info?.Title || meta?.metadata?.get?.("dc:title");
    if (t && String(t).trim() && String(t).toLowerCase() !== "untitled") title = String(t).trim();
  } catch {}
  document.title = title || docName.replace(/\.pdf$/i, "") || "PDF";
}

function loadView() {
  if (!docKey) return null;
  try {
    return JSON.parse(lsGet("positions", "{}"))[docKey] || null;
  } catch {
    return null;
  }
}

let saveTimer = 0;
function saveViewSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveView, 500);
}
function saveView() {
  if (!pdf || !docKey) return;
  try {
    const all = JSON.parse(lsGet("positions", "{}"));
    all[docKey] = { page: current, zoom: zoomMode, scale: +scale.toFixed(3), rotation, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 80) {
      keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 80).forEach((k) => delete all[k]);
    }
    lsSet("positions", JSON.stringify(all));
  } catch {}
}

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast("That does not look like a PDF");
    return;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  await openDocument({ data }, { name: file.name, key: `file:${file.name}:${file.size}:${file.lastModified}` });
}

function pickFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.onchange = () => openFile(input.files[0]);
  input.click();
}

async function downloadPdf() {
  if (!pdf) return;
  try {
    const data = await pdf.getData();
    const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (docName.replace(/[\\/:*?"<>|]/g, "_") || "document").replace(/(?<!\.pdf)$/i, ".pdf");
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    toast("Download failed");
  }
}

let printing = false;
async function printPdf() {
  if (!pdf || printing) return;
  printing = true;
  const root = $("#printRoot");
  const urls = [];
  try {
    root.replaceChildren();
    for (let n = 1; n <= pdf.numPages; n++) {
      toast(`Preparing to print… ${n}/${pdf.numPages}`, 0);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2, rotation: (page.rotate + rotation) % 360 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      root.append(img);
      await img.decode().catch(() => {});
    }
    $("#toast").classList.remove("show");
    await tick();
    window.print();
  } catch (err) {
    console.error(err);
    toast("Could not prepare the document for printing");
  } finally {
    root.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
    printing = false;
  }
}

function resetView() {
  if (!pdf) return;
  rotation = 0;
  zoomMode = "auto";
  state.spread = "none";
  lsSet("spread", "none");
  $("#spreadSelect").value = "none";
  rebuildAll(current);
  toast("View reset");
}

/* ------------------------------------------------------------------ */
/* Zoom input (wheel, pinch, keys)                                     */
/* ------------------------------------------------------------------ */

let zoomTarget = null;
let zoomRaf = 0;
let zoomAnchor = [0, 0];
function zoomTo(target, cx, cy) {
  zoomTarget = clamp(target, MIN_SCALE, MAX_SCALE);
  zoomAnchor = [cx, cy];
  if (zoomRaf) return;
  zoomRaf = requestAnimationFrame(() => {
    zoomRaf = 0;
    const t = zoomTarget;
    zoomTarget = null;
    setScale(t, "custom", zoomAnchor[0], zoomAnchor[1], 140);
  });
}

// Registered on window in the capture phase so the browser never gets to zoom
// the whole page, wherever the pointer is.
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!pdf) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // A mouse wheel notch is large and steps; a touchpad pinch is small and smooth.
    const factor = Math.abs(dy) >= 50 ? (dy < 0 ? 1.1 : 1 / 1.1) : Math.exp(-dy * 0.012);
    const [cx, cy] = stageCoords(e.clientX, e.clientY);
    zoomTo((zoomTarget ?? scale) * factor, cx, cy);
  },
  { passive: false, capture: true }
);

let pinch = null;
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
stage.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2) pinch = { d: touchDist(e.touches), s: scale };
  },
  { passive: true }
);
stage.addEventListener(
  "touchmove",
  (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const t = e.touches;
    const [cx, cy] = stageCoords((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);
    zoomTo((pinch.s * touchDist(t)) / pinch.d, cx, cy);
  },
  { passive: false }
);
stage.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) pinch = null;
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

$("#prev").onclick = () => stepPage(-1);
$("#next").onclick = () => stepPage(1);
$("#pageNumber").onfocus = (e) => e.target.select();
$("#pageNumber").onkeydown = (e) => {
  if (e.key === "Enter") {
    go(+e.target.value || current, "auto");
    e.target.blur();
  } else if (e.key === "Escape") {
    e.target.value = current;
    e.target.blur();
  }
  e.stopPropagation();
};
$("#pageNumber").onblur = (e) => (e.target.value = current);

$("#zoomIn").onclick = () => stepZoom(1);
$("#zoomOut").onclick = () => stepZoom(-1);
$("#zoomSelect").onchange = (e) => {
  if (e.target.value !== "custom") setZoomMode(e.target.value);
  e.target.blur();
};
$("#spreadSelect").onchange = (e) => {
  setSpread(e.target.value);
  e.target.blur();
};
$("#rotate").onclick = () => rotate(1);

$("#sidebarToggle").onclick = () => toggleSidebar();
$("#sidebarClose").onclick = () => toggleSidebar(false);
$$(".side-tab").forEach((t) => (t.onclick = () => showSideTab(t.dataset.panel)));

$("#searchButton").onclick = toggleFind;
$("#findClose").onclick = closeFind;
$("#findNext").onclick = () => stepHit(1);
$("#findPrev").onclick = () => stepHit(-1);
$("#findCase").onclick = (e) => {
  state.matchCase = !state.matchCase;
  lsSet("matchCase", state.matchCase);
  e.currentTarget.setAttribute("aria-pressed", String(state.matchCase));
  runSearch();
};
$("#findInput").oninput = () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runSearch, 180);
};
$("#findInput").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (normalizeQuery(e.target.value, state.matchCase) !== search.q) {
    clearTimeout(findTimer);
    runSearch();
  } else {
    stepHit(e.shiftKey ? -1 : 1);
  }
};

$("#themeButton").onclick = () => togglePopup("#themePanel", "#themeButton");
$("#closeTheme").onclick = closePopups;
$("#moreButton").onclick = () => togglePopup("#moreMenu", "#moreButton");
$("#brightness").oninput = (e) => {
  state.brightness = +e.target.value;
  applyTheme();
};
$("#contrast").oninput = (e) => {
  state.contrast = +e.target.value;
  applyTheme();
};
$("#preserveImages").onchange = (e) => {
  state.preserveImages = e.target.checked;
  applyTheme();
};
$("#themeReset").onclick = () => {
  state.brightness = 100;
  state.contrast = 100;
  applyTheme();
};

const menuAction = (id, fn) =>
  ($(id).onclick = () => {
    closePopups();
    fn();
  });
menuAction("#mOpen", pickFile);
menuAction("#mDownload", downloadPdf);
menuAction("#mPrint", printPdf);
menuAction("#mFullscreen", toggleFullscreen);
menuAction("#mFirst", () => go(1, "auto"));
menuAction("#mLast", () => pdf && go(pdf.numPages, "auto"));
menuAction("#mInfo", () => {
  toggleSidebar(true);
  showSideTab("infoPanel");
});
menuAction("#mReset", resetView);
menuAction("#mKeys", () => $("#keysDialog").showModal());
$("#openFile").onclick = pickFile;

document.addEventListener("fullscreenchange", () => {
  $("#mFullscreen").textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
});

window.addEventListener("click", (e) => {
  if (!e.target.closest("#moreMenu, #moreButton, #themePanel, #themeButton")) closePopups();
});

stage.addEventListener("scroll", onScroll, { passive: true });

let resizeRaf = 0;
new ResizeObserver(() => {
  if (!pdf) return;
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (zoomMode !== "custom") setScale(fitScale(zoomMode), zoomMode);
    else scheduleRender();
  });
}).observe(stage);

// Drag and drop a PDF anywhere on the window
window.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  $("#welcome").classList.add("drag");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) $("#welcome").classList.remove("drag");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("#welcome").classList.remove("drag");
  openFile(e.dataTransfer?.files?.[0]);
});

window.addEventListener("pagehide", () => {
  saveView();
  flushNotes();
});

window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (mod && lower === "f") return e.preventDefault(), toggleFind();
    if (mod && lower === "o") return e.preventDefault(), pickFile();
    if (mod && lower === "s") return e.preventDefault(), downloadPdf();
    if (mod && lower === "p") return e.preventDefault(), printPdf();
    if (mod && lower === "g") return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
    if (mod && (key === "+" || key === "=" || e.code === "NumpadAdd")) return e.preventDefault(), stepZoom(1);
    if (mod && (key === "-" || key === "_" || e.code === "NumpadSubtract")) return e.preventDefault(), stepZoom(-1);
    if (mod && key === "0") return e.preventDefault(), setScale(1, "custom");

    if (key === "Escape") {
      if (hideFloaters()) return;
      if (!$("#moreMenu").hidden || !$("#themePanel").hidden) closePopups();
      else if (!$("#findbar").hidden) closeFind();
      return;
    }
    if (key === "F3") return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
    if (key === "F4") return e.preventDefault(), toggleSidebar();

    if (e.target.closest?.("input, select, textarea, dialog") || mod || e.altKey || !pdf) return;

    const canScrollX = stage.scrollWidth > stage.clientWidth + 2;
    const page = stage.clientHeight * 0.9;
    switch (key) {
      case "ArrowDown": e.preventDefault(); stage.scrollBy({ top: 60 }); break;
      case "ArrowUp": e.preventDefault(); stage.scrollBy({ top: -60 }); break;
      case "PageDown": e.preventDefault(); stage.scrollBy({ top: page, behavior: "smooth" }); break;
      case "PageUp": e.preventDefault(); stage.scrollBy({ top: -page, behavior: "smooth" }); break;
      case " ": e.preventDefault(); stage.scrollBy({ top: e.shiftKey ? -page : page, behavior: "smooth" }); break;
      case "ArrowRight": e.preventDefault(); canScrollX ? stage.scrollBy({ left: 60 }) : stepPage(1); break;
      case "ArrowLeft": e.preventDefault(); canScrollX ? stage.scrollBy({ left: -60 }) : stepPage(-1); break;
      case "Home": e.preventDefault(); go(1, "auto"); break;
      case "End": e.preventDefault(); go(pdf.numPages, "auto"); break;
      case "r": case "R": rotate(e.shiftKey ? -1 : 1); break;
    }
  },
  true
);

/* ------------------------------------------------------------------ */
/* Links inside the document                                           */
/* ------------------------------------------------------------------ */

function pageAtEvent(e) {
  const el = e.target.closest?.(".page");
  if (!el) return null;
  const p = pages[+el.dataset.page];
  if (!p) return null;
  const r = el.getBoundingClientRect();
  return { p, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
}

const findLink = (p, fx, fy) => p.links.find((l) => fx >= l.x && fx <= l.x + l.w && fy >= l.y && fy <= l.y + l.h) || null;

function performLink(l) {
  if (l.dest) goDest(l.dest);
  else if (l.url) window.open(l.url, "_blank", "noopener,noreferrer");
  else if (l.action) {
    const actions = {
      NextPage: () => stepPage(1),
      PrevPage: () => stepPage(-1),
      FirstPage: () => go(1, "auto"),
      LastPage: () => go(pdf.numPages, "auto"),
    };
    actions[l.action]?.();
  }
}

let linkHover = null;
stage.addEventListener("mousemove", (e) => {
  if (e.buttons || !pdf) return;
  const hit = pageAtEvent(e);
  const link = hit && findLink(hit.p, hit.fx, hit.fy);
  stage.classList.toggle("overlink", !!link);
  if (!link) return linkHover?.remove();
  if (!linkHover) {
    linkHover = document.createElement("div");
    linkHover.className = "linkHover";
  }
  if (linkHover.parentNode !== hit.p.el) hit.p.el.append(linkHover);
  Object.assign(linkHover.style, { left: link.x * 100 + "%", top: link.y * 100 + "%", width: link.w * 100 + "%", height: link.h * 100 + "%" });
});
stage.addEventListener("mouseleave", () => {
  linkHover?.remove();
  stage.classList.remove("overlink");
});

/* ------------------------------------------------------------------ */
/* Highlights and comments                                             */
/* ------------------------------------------------------------------ */

const HL_COLORS = {
  yellow: "255,212,0",
  green: "88,214,88",
  blue: "74,168,255",
  pink: "255,111,181",
  orange: "255,154,60",
};

let notes = []; // { id, page, color, text, note, rot, rects: [[x, y, w, h] as page fractions], t, cont }
let notesTimer = 0;
let notesDirty = false;
let activeNote = null;

const notesKey = () => (docKey ? "ann:" + docKey : null);

async function loadNotes(gen) {
  const key = notesKey();
  if (!key) return;
  try {
    const r = await chrome.storage.local.get(key);
    if (gen !== docGen) return;
    notes = r[key] || [];
  } catch (err) {
    console.warn("Could not load notes", err);
  }
  eachPage(drawHighlights);
  renderNotesPanel();
}

function saveNotesSoon() {
  notesDirty = true;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(flushNotes, 400);
}

async function flushNotes() {
  clearTimeout(notesTimer);
  const key = notesKey();
  if (!key || !notesDirty) return;
  notesDirty = false;
  try {
    if (notes.length) await chrome.storage.local.set({ [key]: notes });
    else await chrome.storage.local.remove(key);
  } catch (err) {
    console.warn("Could not save notes", err);
    toast("Could not save your notes");
  }
}

// Rotate page-fraction rects from one viewport rotation to another.
function rotateRects(rects, from, to) {
  const turns = ((((to - from) % 360) + 360) % 360) / 90;
  return rects.map((r) => {
    let [x, y, w, h] = r;
    for (let i = 0; i < turns; i++) [x, y, w, h] = [1 - y - h, x, h, w];
    return [x, y, w, h];
  });
}

function drawHighlights(p) {
  $$(".hlLayer, .noteMark", p.el).forEach((n) => n.remove());
  if (p.state !== "ok") return;
  const list = notes.filter((n) => n.page === p.num);
  if (!list.length) return;
  const layer = document.createElement("div");
  layer.className = "hlLayer";
  for (const n of list) {
    const rects = rotateRects(n.rects, n.rot, p.renderRot);
    for (const [x, y, w, h] of rects) {
      const d = document.createElement("div");
      d.className = "hl";
      d.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;background:rgba(${HL_COLORS[n.color] || HL_COLORS.yellow},.42)`;
      layer.append(d);
    }
    if (n.note && rects.length) {
      const [x, y, w] = rects[0];
      const m = document.createElement("button");
      m.className = "noteMark";
      m.title = n.note;
      m.style.left = (x + w) * 100 + "%";
      m.style.top = y * 100 + "%";
      m.innerHTML = '<svg><use href="#i-note"/></svg>';
      m.onclick = (e) => {
        e.stopPropagation();
        openNotePop(n, m.getBoundingClientRect());
      };
      p.el.append(m);
    }
  }
  p.el.insertBefore(layer, p.el.querySelector(".textLayer"));
}

const redrawPage = (n) => pages[n] && drawHighlights(pages[n]);

function mergeRects(list) {
  list = list.filter((r) => r.w > 1 && r.h > 1).sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  for (const r of list) {
    const contained = out.some((o) => r.l >= o.l - 1 && r.t >= o.t - 1 && r.l + r.w <= o.l + o.w + 1 && r.t + r.h <= o.t + o.h + 1);
    if (contained) continue;
    const same = out.find((o) => Math.min(o.t + o.h, r.t + r.h) - Math.max(o.t, r.t) > Math.min(o.h, r.h) * 0.6 && r.l <= o.l + o.w + 3 && r.l + r.w >= o.l - 3);
    if (same) {
      const right = Math.max(same.l + same.w, r.l + r.w);
      const bottom = Math.max(same.t + same.h, r.t + r.h);
      same.l = Math.min(same.l, r.l);
      same.t = Math.min(same.t, r.t);
      same.w = right - same.l;
      same.h = bottom - same.t;
    } else out.push({ ...r });
  }
  return out;
}

// What is selected right now inside the document: the text, plus its
// rectangles per page expressed as fractions of the page.
function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el?.closest("#pages")) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;

  const perPage = new Map();
  let anchor = null;
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const n of visible) {
      const p = pages[n];
      const pr = p.el.getBoundingClientRect();
      if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
      if (r.width > pr.width * 0.98 && r.height > pr.height * 0.5) break; // a container, not text
      if (!perPage.has(n)) perPage.set(n, { p, pr, list: [] });
      perPage.get(n).list.push({ l: r.left - pr.left, t: r.top - pr.top, w: r.width, h: r.height });
      anchor = r;
      break;
    }
  }
  if (!perPage.size) return null;

  const parts = [...perPage.values()]
    .sort((a, b) => a.p.num - b.p.num)
    .map(({ p, pr, list }) => ({
      page: p.num,
      rot: p.renderRot,
      rects: mergeRects(list).map((r) => [r.l / pr.width, r.t / pr.height, r.w / pr.width, r.h / pr.height]),
    }))
    .filter((x) => x.rects.length);
  return parts.length ? { text, parts, anchor: anchor.toJSON ? anchor.toJSON() : anchor } : null;
}

function createNotes(info, color) {
  const g = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const made = info.parts.map((part, i) => ({
    id: g + i,
    g,
    page: part.page,
    color,
    text: info.text,
    note: "",
    rot: part.rot,
    rects: part.rects,
    t: Date.now(),
    cont: i > 0,
  }));
  notes.push(...made);
  made.forEach((n) => redrawPage(n.page));
  state.hlColor = color;
  lsSet("hlColor", color);
  saveNotesSoon();
  renderNotesPanel();
  return made[0];
}

const selectedNotes = new Set();

// Removes the given highlights; a highlight spanning pages is removed as a whole.
function deleteNotes(list) {
  const groups = new Set(list.map((n) => n.g).filter(Boolean));
  const doomed = new Set(list);
  for (const x of notes) if (x.g && groups.has(x.g)) doomed.add(x);
  const touched = new Set([...doomed].map((x) => x.page));
  notes = notes.filter((x) => !doomed.has(x));
  for (const x of doomed) selectedNotes.delete(x.id);
  touched.forEach(redrawPage);
  saveNotesSoon();
  renderNotesPanel();
}

function removeHighlights(list) {
  if (!list.length) return;
  if (list.some((n) => n.note) && !window.confirm("This highlight has a comment, which will be deleted with it. Continue?")) return;
  deleteNotes(list);
  toast(list.length > 1 ? "Highlights removed" : "Highlight removed");
}

const overlapRects = (a, b) => {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0.002 && h > 0.003 && w * h > 0.2 * Math.min(a[2] * a[3], b[2] * b[3]);
};

// Existing highlights that the current selection touches.
function overlappingNotes(info) {
  const out = new Set();
  for (const part of info.parts) {
    for (const n of notes) {
      if (n.page !== part.page) continue;
      const nr = rotateRects(n.rects, n.rot, part.rot);
      if (nr.some((a) => part.rects.some((b) => overlapRects(a, b)))) out.add(n);
    }
  }
  return [...out];
}

// True when every selected line lies inside one of the given highlights.
function coveredBy(info, list) {
  return info.parts.every((part) =>
    part.rects.every((b) =>
      list.some(
        (n) =>
          n.page === part.page &&
          rotateRects(n.rects, n.rot, part.rot).some(
            (a) => b[0] >= a[0] - 0.004 && b[0] + b[2] <= a[0] + a[2] + 0.004 && b[1] >= a[1] - 0.01 && b[1] + b[3] <= a[1] + a[3] + 0.01
          )
      )
    )
  );
}

// Picking a color on a selection: same color on already-highlighted text turns
// the highlight off, anything else adds (or recolors) it without stacking.
function applyColor(info, color) {
  const over = overlappingNotes(info);
  const same = over.filter((n) => n.color === color);
  if (same.length && coveredBy(info, same)) {
    removeHighlights(same);
    return;
  }
  deleteNotes(over.filter((n) => !n.note));
  createNotes(info, color);
}

function noteAtPoint(p, fx, fy) {
  let best = null;
  let bestArea = Infinity;
  for (const n of notes) {
    if (n.page !== p.num) continue;
    for (const [x, y, w, h] of rotateRects(n.rects, n.rot, p.renderRot)) {
      if (fx >= x && fx <= x + w && fy >= y && fy <= y + h && w * h < bestArea) {
        best = n;
        bestArea = w * h;
      }
    }
  }
  return best;
}

/* ----- floating UI helpers ----- */

function placeNear(el, rect) {
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = rect.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
  const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - w - 8));
  el.style.top = top + "px";
  el.style.left = left + "px";
}

function hideFloaters() {
  const open = ["#selBar", "#notePop", "#tPop"].filter((id) => !$(id).hidden);
  open.forEach((id) => ($(id).hidden = true));
  activeNote = null;
  trToken++;
  return open.length > 0;
}

function colorDots(container, onPick) {
  for (const [name, rgb] of Object.entries(HL_COLORS)) {
    const b = document.createElement("button");
    b.className = "dot";
    b.dataset.color = name;
    b.title = name[0].toUpperCase() + name.slice(1);
    b.style.setProperty("--c", `rgb(${rgb})`);
    b.onmousedown = (e) => e.preventDefault(); // keep the text selected
    b.onclick = () => onPick(name);
    container.append(b);
  }
}

/* ----- selection toolbar ----- */

let selInfo = null;

stage.addEventListener("mouseup", () => {
  setTimeout(() => {
    const info = selectionInfo();
    if (!info) return;
    selInfo = info;
    $("#notePop").hidden = true;
    $("#tPop").hidden = true;
    $('#selBar [data-act="unhighlight"]').hidden = !overlappingNotes(info).length;
    placeNear($("#selBar"), info.anchor);
  }, 10);
});

window.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#selBar, #notePop, #tPop, .noteMark")) hideFloaters();
});
stage.addEventListener("scroll", () => {
  if (!$("#selBar").hidden) $("#selBar").hidden = true;
}, { passive: true });

$("#selBar").addEventListener("mousedown", (e) => {
  if (e.target.tagName !== "SELECT") e.preventDefault();
});

$("#selBar").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act || !selInfo) return;
  const info = selInfo;
  const rect = info.anchor;
  if (act === "unhighlight") {
    removeHighlights(overlappingNotes(info));
    window.getSelection().removeAllRanges();
    $("#selBar").hidden = true;
  } else if (act === "comment") {
    const existing = overlappingNotes(info).find((n) => coveredBy(info, [n]));
    const n = existing || createNotes(info, state.hlColor);
    window.getSelection().removeAllRanges();
    $("#selBar").hidden = true;
    openNotePop(n, rect);
    $("#noteText").focus();
  } else if (act === "translate") {
    $("#selBar").hidden = true;
    openTranslate(info.text, rect);
  } else if (act === "listen") {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(info.text));
    $("#selBar").hidden = true;
  } else if (act === "copy") {
    try {
      await navigator.clipboard.writeText(info.text);
      toast("Copied");
    } catch {
      toast("Could not copy");
    }
    $("#selBar").hidden = true;
  }
});

colorDots($("#selColors"), (color) => {
  if (!selInfo) return;
  applyColor(selInfo, color);
  window.getSelection().removeAllRanges();
  $("#selBar").hidden = true;
});

/* ----- editing an existing highlight ----- */

let noteSaveTimer = 0;

function openNotePop(n, rect) {
  activeNote = n;
  $("#selBar").hidden = true;
  $("#tPop").hidden = true;
  $("#noteQuote").textContent = n.text.length > 140 ? n.text.slice(0, 140) + "…" : n.text;
  $("#noteText").value = n.note || "";
  $("#noteSaved").textContent = "";
  $$("#noteColors .dot").forEach((d) => d.classList.toggle("on", d.dataset.color === n.color));
  placeNear($("#notePop"), rect);
}

colorDots($("#noteColors"), (color) => {
  if (!activeNote) return;
  if (color === activeNote.color) {
    // Choosing the color it already has turns the highlight off.
    const n = activeNote;
    if (n.note && !window.confirm("This highlight has a comment, which will be deleted with it. Continue?")) return;
    deleteNotes([n]);
    hideFloaters();
    toast("Highlight removed");
    return;
  }
  activeNote.color = color;
  redrawPage(activeNote.page);
  $$("#noteColors .dot").forEach((d) => d.classList.toggle("on", d.dataset.color === color));
  saveNotesSoon();
  renderNotesPanel();
});

$("#noteText").addEventListener("input", () => {
  if (!activeNote) return;
  const n = activeNote;
  n.note = $("#noteText").value;
  $("#noteSaved").textContent = "Saving…";
  saveNotesSoon();
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(async () => {
    redrawPage(n.page);
    renderNotesPanel();
    await flushNotes();
    $("#noteSaved").textContent = "Saved";
  }, 450);
});
$("#noteText").addEventListener("keydown", (e) => e.stopPropagation());
$("#noteDelete").onclick = () => {
  if (!activeNote) return;
  const n = activeNote;
  hideFloaters();
  removeHighlights([n]);
};

stage.addEventListener("click", (e) => {
  if (!pdf || String(window.getSelection()).trim()) return;
  const hit = pageAtEvent(e);
  if (!hit) return;
  const link = findLink(hit.p, hit.fx, hit.fy);
  if (link) return performLink(link);
  if (e.target.closest(".noteMark")) return;
  const n = noteAtPoint(hit.p, hit.fx, hit.fy);
  if (n) openNotePop(n, new DOMRect(e.clientX, e.clientY, 1, 1));
});

/* ----- Notes tab ----- */

const primaryNotes = () => notes.filter((n) => !n.cont).sort((a, b) => a.page - b.page || a.rects[0][1] - b.rects[0][1]);

// Two-step confirmation for destructive actions in the sidebar.
function confirmTwice(first, second) {
  return new Promise((resolve) => {
    const dlg = $("#confirmDlg");
    const ok = $("#confirmOk");
    let step = 1;
    $("#confirmMsg").textContent = first;
    ok.textContent = "Delete";
    ok.onclick = () => {
      if (step === 1) {
        step = 2;
        $("#confirmMsg").textContent = second;
        ok.textContent = "Yes, delete permanently";
      } else {
        resolve(true);
        dlg.close();
      }
    };
    $("#confirmCancel").onclick = () => {
      resolve(false);
      dlg.close();
    };
    dlg.onclose = () => resolve(false);
    dlg.showModal();
  });
}

async function deleteFromSidebar(list) {
  if (!list.length) return;
  const one = list.length === 1;
  const withComments = list.filter((n) => n.note).length;
  const first = one
    ? "Delete this highlight" + (list[0].note ? " and its comment?" : "?")
    : `Delete ${list.length} highlights${withComments ? ` and ${withComments} ${withComments === 1 ? "comment" : "comments"}` : ""}?`;
  const second = one ? "This cannot be undone. Delete it permanently?" : `This cannot be undone. Permanently delete these ${list.length} highlights?`;
  if (!(await confirmTwice(first, second))) return;
  deleteNotes(list);
  toast(one ? "Highlight deleted" : `${list.length} highlights deleted`);
}

function renderNotesPanel() {
  const panel = $("#notesPanel");
  const keepScroll = panel.scrollTop;
  panel.replaceChildren();
  const list = primaryNotes();
  for (const id of [...selectedNotes]) if (!list.some((n) => n.id === id)) selectedNotes.delete(id);

  const head = document.createElement("div");
  head.className = "notes-head";
  if (list.length) {
    const all = document.createElement("label");
    all.className = "notes-all";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selectedNotes.size === list.length;
    box.indeterminate = selectedNotes.size > 0 && selectedNotes.size < list.length;
    box.onchange = () => {
      if (box.checked) list.forEach((n) => selectedNotes.add(n.id));
      else selectedNotes.clear();
      renderNotesPanel();
    };
    all.append(box, document.createTextNode(selectedNotes.size ? `${selectedNotes.size} selected` : `${list.length} ${list.length === 1 ? "highlight" : "highlights"}`));
    head.append(all);

    const actions = document.createElement("span");
    actions.className = "notes-actions";
    if (selectedNotes.size) {
      const del = document.createElement("button");
      del.className = "link danger-text";
      del.textContent = "Delete selected";
      del.onclick = () => deleteFromSidebar(list.filter((n) => selectedNotes.has(n.id)));
      actions.append(del);
    }
    const exp = document.createElement("button");
    exp.className = "link";
    exp.textContent = "Export";
    exp.title = "Export as Markdown";
    exp.onclick = exportNotes;
    actions.append(exp);
    head.append(actions);
  } else {
    head.textContent = "No highlights yet";
  }
  panel.append(head);

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = "Select text in the document to highlight it, add a comment, or translate it. Everything is saved automatically.";
    panel.append(empty);
    return;
  }

  for (const n of list) {
    const row = document.createElement("div");
    row.className = "note-row";
    row.style.setProperty("--c", `rgb(${HL_COLORS[n.color] || HL_COLORS.yellow})`);

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selectedNotes.has(n.id);
    box.title = "Select";
    box.onchange = () => {
      if (box.checked) selectedNotes.add(n.id);
      else selectedNotes.delete(n.id);
      renderNotesPanel();
    };

    const item = document.createElement("button");
    item.className = "note-item";
    const meta = document.createElement("div");
    meta.className = "n-meta";
    meta.textContent = "Page " + n.page;
    const quote = document.createElement("div");
    quote.className = "n-quote";
    quote.textContent = n.text;
    item.append(meta, quote);
    if (n.note) {
      const c = document.createElement("div");
      c.className = "n-comment";
      c.textContent = n.note;
      item.append(c);
    }
    item.onclick = () => {
      go(n.page, "auto");
      const p = pages[n.page];
      if (p) stage.scrollBy({ top: n.rects[0][1] * p.el.getBoundingClientRect().height - 90 });
    };

    const del = document.createElement("button");
    del.className = "icon sm note-del";
    del.title = "Delete";
    del.setAttribute("aria-label", "Delete highlight");
    del.innerHTML = '<svg><use href="#i-close"/></svg>';
    del.onclick = () => deleteFromSidebar([n]);

    row.append(box, item, del);
    panel.append(row);
  }
  panel.scrollTop = keepScroll;
}

function exportNotes() {
  const list = selectedNotes.size ? primaryNotes().filter((n) => selectedNotes.has(n.id)) : primaryNotes();
  let md = `# Notes: ${document.title}\n\n`;
  for (const n of list) {
    md += `**Page ${n.page}**\n\n> ${n.text}\n\n`;
    if (n.note) md += `${n.note}\n\n`;
  }
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = (docName.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_") || "notes") + "-notes.md";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------------ */
/* Translate                                                           */
/* ------------------------------------------------------------------ */

const LANGS = [
  ["en", "English"], ["ur", "Urdu"], ["ar", "Arabic"], ["hi", "Hindi"], ["fa", "Persian"], ["ps", "Pashto"],
  ["pa", "Punjabi"], ["sd", "Sindhi"], ["bn", "Bengali"], ["ta", "Tamil"], ["tr", "Turkish"], ["fr", "French"],
  ["de", "German"], ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["sv", "Swedish"],
  ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["el", "Greek"], ["he", "Hebrew"], ["zh-CN", "Chinese (Simplified)"],
  ["ja", "Japanese"], ["ko", "Korean"], ["th", "Thai"], ["vi", "Vietnamese"], ["id", "Indonesian"], ["sw", "Swahili"],
];
const langName = (code) => LANGS.find(([c]) => c.toLowerCase() === String(code).toLowerCase())?.[1] || code;

let trToken = 0;
let trText = "";

function initLangSelect() {
  const sel = $("#trLang");
  for (const [code, name] of LANGS) sel.append(new Option(name, code));
  if (!LANGS.some(([c]) => c === state.trLang)) {
    const guess = (navigator.language || "en").split("-")[0];
    state.trLang = LANGS.some(([c]) => c === guess) ? guess : "en";
  }
  sel.value = state.trLang;
  sel.onchange = () => {
    state.trLang = sel.value;
    lsSet("trLang", state.trLang);
    runTranslate();
  };
}

function openTranslate(text, rect) {
  trText = text.slice(0, 1500);
  $("#trSrc").textContent = text.length > 200 ? text.slice(0, 200) + "…" : text;
  placeNear($("#tPop"), rect);
  runTranslate();
}

async function runTranslate() {
  const token = ++trToken;
  const out = $("#trOut");
  const meta = $("#trMeta");
  out.textContent = "Translating…";
  meta.textContent = "";
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=" +
      encodeURIComponent(state.trLang) +
      "&q=" +
      encodeURIComponent(trText);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (token !== trToken) return;
    out.textContent = data[0].map((part) => part[0]).join("");
    if (data[2] && data[2] !== state.trLang) meta.textContent = "From " + langName(data[2]);
    else if (data[2]) meta.textContent = "Already in " + langName(data[2]);
  } catch (err) {
    if (token !== trToken) return;
    console.warn("Translation failed", err);
    out.textContent = "Translation failed. Check your internet connection and try again.";
  }
}

$("#trCopy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#trOut").textContent);
    toast("Copied");
  } catch {}
};
$("#trClose").onclick = () => ($("#tPop").hidden = true);

stage.addEventListener("dblclick", () => {
  if (!state.dblTranslate || !pdf) return;
  const info = selectionInfo();
  if (!info) return;
  $("#selBar").hidden = true;
  $("#notePop").hidden = true;
  openTranslate(info.text, info.anchor);
});

function syncDblLabel() {
  $("#mDbl").firstChild.textContent = "Translate on double-click";
  $("#mDbl kbd").textContent = state.dblTranslate ? "On" : "Off";
}
$("#mDbl").onclick = () => {
  state.dblTranslate = !state.dblTranslate;
  lsSet("dblTranslate", state.dblTranslate);
  syncDblLabel();
};

/* ------------------------------------------------------------------ */
/* Missing support files                                               */
/* ------------------------------------------------------------------ */
// Scanned pages, JPEG 2000 images and ICC colors need the files in pdfjs/wasm.
// Without them such pages come out blank, so say so instead of failing quietly.

async function checkAssets() {
  const needed = ["wasm/openjpeg.wasm", "wasm/jbig2.wasm", "wasm/qcms_bg.wasm", "standard_fonts/FoxitSerif.pfb"];
  const missing = [];
  for (const f of needed) {
    try {
      const r = await fetch(asset(f));
      if (!r.ok) missing.push(f);
    } catch {
      missing.push(f);
    }
  }
  if (!missing.length) return;
  const b = $("#banner");
  b.textContent = "Some PDF.js support files are missing (" + missing.join(", ") + "). Scanned books and some other PDFs will show blank pages. Run tools/fetch-pdfjs again, then reload the extension.";
  b.hidden = false;
  $("#bannerClose").hidden = false;
}
$("#bannerClose").onclick = () => {
  $("#banner").hidden = true;
  $("#bannerClose").hidden = true;
};

initLangSelect();
syncDblLabel();
renderNotesPanel();

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

buildThemeList();
applyTheme();
$("#spreadSelect").value = state.spread;
$("#findCase").setAttribute("aria-pressed", String(state.matchCase));
updateZoomUI();

(async function start() {
  const src = parseSrc();
  if (!src) {
    $("#loading").classList.add("hidden");
    $("#welcome").hidden = false;
    document.title = "PDF Theme Reader";
    return;
  }
  const page = +(location.hash.match(/page=(\d+)/)?.[1] || 0) || undefined;
  await openDocument({ url: src }, { name: nameFromUrl(src), key: src.startsWith("blob:") ? null : src, src, page });
})();
