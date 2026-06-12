/* ============================================================
   HS 汇聚算力 · 放映室工作台
   单文件应用：访问授权 / 视频·图片双模式创作 / 素材库 /
   任务轮询 / 公告 / 图片编辑器（含自动人脸马赛克）。
   与旧版前端共用 localStorage 键，可无缝迁移。
   ============================================================ */
(() => {
  "use strict";

  /* ==================== A. 常量 ==================== */

  const LS_KEY = "dreamina_credit_license_key";
  const LS_FP = "dreamina_credit_fingerprint";
  const LS_DISMISSED = "dreamina_credit_dismissed_announcements";
  const LS_THEME = "hs_theme";
  const taskStoreKey = (key) => `dreamina_credit_tasks:${String(key || "").trim().toUpperCase() || "anonymous"}`;

  const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
  const IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];
  const FALLBACK_DURATIONS = Array.from({ length: 12 }, (_, i) => `${4 + i}s`);
  const DEFAULT_DURATION = "15s";
  const FALLBACK_MODELS = ["限时使用SD 2"];
  const FALLBACK_TIERS = ["Auto", "1K", "2K", "4K"];

  const IMG_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif"]);
  const IMG_EXT = /\.(jpe?g|png|webp|bmp|tiff?|gif)$/i;
  const AUD_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav"]);
  const AUD_EXT = /\.(mp3|wav)$/i;

  const IMG_MAX_BYTES = 0x1e00000;   // 30 MB
  const AUD_MAX_BYTES = 0xf00000;    // 15 MB
  const BATCH_MAX_BYTES = 0x4000000; // 64 MB
  const IMG_MIN_PX = 300;
  const IMG_MAX_PX = 6000;
  const IMG_AR_MIN = 0.4;
  const IMG_AR_MAX = 2.5;
  const AUD_MIN_S = 2;
  const AUD_MAX_S = 15;
  const AUD_TOTAL_S = 15;
  const MAX_AUDIOS = 3;
  const POLL_MS = 5000;
  const TASK_CAP = 30;

  /* ==================== B. 小工具 ==================== */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, cls, ...children) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function icon(name, size) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    if (size) { svg.style.width = size + "px"; svg.style.height = size + "px"; }
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "--";
    if (n >= 1048576) return `${(n / 1048576).toFixed(n >= 0xa00000 ? 0 : 1)} MB`;
    if (n >= 1024) return `${Math.ceil(n / 1024)} KB`;
    return `${n} B`;
  }

  function fmtPoints(n) {
    if (n == null || !Number.isFinite(Number(n))) return "--";
    const v = Math.round(Number(n) * 100) / 100;
    return String(v);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    if (diff < 60e3) return "刚刚";
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function errMsg(e) {
    if (!e) return "未知错误";
    if (typeof e === "string") return e;
    if (e instanceof Error) return e.message || "未知错误";
    if (typeof e === "object") {
      const t = e.error, up = t && t.upstream, ue = up && up.error;
      return String(
        (t && t.message) || (up && up.reason) || (ue && (ue.message || ue.code)) ||
        e.reason || e.message || JSON.stringify(e)
      );
    }
    return String(e);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  }

  function isHttpUrl(u) {
    try {
      const x = new URL(String(u));
      return x.protocol === "http:" || x.protocol === "https:";
    } catch { return false; }
  }

  function isImageFile(f) {
    const t = String(f.type || "").toLowerCase();
    return IMG_MIME.has(t) || IMG_EXT.test(f.name || "");
  }
  function isAudioFile(f) {
    const t = String(f.type || "").toLowerCase();
    return AUD_MIME.has(t) || AUD_EXT.test(f.name || "");
  }

  function splitLines(text) {
    return String(text || "").split(/\n|,/).map(s => s.trim()).filter(Boolean);
  }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ==================== C. API 客户端 ==================== */

  async function parseBody(res) {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { error: { message: text } }; }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await parseBody(res);
    if (!res.ok) throw new Error(errMsg(data));
    return data;
  }

  async function uploadFiles(url, files, auth) {
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-license-key": auth.licenseKey, "x-fingerprint": auth.fingerprint },
      body: fd
    });
    const data = await parseBody(res);
    if (!res.ok) throw new Error(errMsg(data));
    return data;
  }

  const displayName = () => navigator.userAgent.slice(0, 80);

  /* 幂等 GET 自动重试：网络抖动 / 上游瞬时 5xx 重试两次再放弃 */
  async function fetchRetry(url, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.status >= 500 && i < tries - 1) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (i < tries - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
    }
    throw lastErr;
  }

  const api = {
    async config() {
      const res = await fetchRetry("/api/app/config");
      const data = await parseBody(res);
      if (!res.ok) throw new Error(errMsg(data));
      return data;
    },
    async announcements(placement) {
      const res = await fetchRetry(`/api/app/announcements?placement=${placement}`);
      const data = await parseBody(res);
      return res.ok && Array.isArray(data.announcements) ? data.announcements : [];
    },
    activate: (key, fp) => postJson("/api/app/license/activate", { licenseKey: key, fingerprint: fp, displayName: displayName() }),
    balance: (key, fp) => postJson("/api/app/license/balance", { licenseKey: key, fingerprint: fp, displayName: displayName() }),
    generate: (body) => postJson("/api/app/generate", body),
    videoTask: (body) => postJson("/api/app/task", body),
    imageGenerate: (body) => postJson("/api/app/image/generate", body),
    imageTask: (body) => postJson("/api/app/image/task", body),
    uploadImages: (files, auth) => uploadFiles("/api/app/upload-image", files, auth),
    uploadAudios: (files, auth) => uploadFiles("/api/app/upload-audio", files, auth),
    assetsList: (key, fp, limit) => postJson("/api/app/assets/list", { licenseKey: key, fingerprint: fp, limit: limit || 40 }),
    assetsRegister: (body) => postJson("/api/app/assets/register", body),
    assetsDelete: (key, fp, assetId) => postJson("/api/app/assets/delete", { licenseKey: key, fingerprint: fp, assetId })
  };

  function proxyDownloadUrl(url, filename) {
    return `/api/app/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  }
  function bestDownloadUrl(url, filename) {
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && u.hostname === "file.hjsuanli.com") {
        u.searchParams.set("download", "1");
        u.searchParams.set("filename", filename);
        return u.toString();
      }
    } catch { /* fall through */ }
    return proxyDownloadUrl(url, filename);
  }

  /* ==================== D. 全局状态 ==================== */

  const state = {
    view: "boot",
    licenseKey: "",
    fingerprint: "",
    config: null,
    balance: null,

    mode: "video",
    videoModel: FALLBACK_MODELS[0],
    duration: DEFAULT_DURATION,
    videoRatio: VIDEO_RATIOS[0],
    refMode: "multimodal",
    imageModel: FALLBACK_TIERS[0],
    imageRatio: IMAGE_RATIOS[0],

    localImages: [],   // {id,file,previewUrl,name,size,type,width,height,error,maskStatus,edited}
    localAudios: [],   // {id,file,previewUrl,name,size,duration,error}
    urlImages: [],     // string[]
    urlAudios: [],     // {url,name?,duration?,assetId?}

    assets: [],        // 服务端素材库
    recentAssets: [],  // 近期引用过的素材 {id,kind,url}（内存，最多 80）
    libraryLoading: false,

    tasks: [],
    announcements: [],
    dismissed: [],

    submitting: false,
    uploading: false,
    pricingOpen: false,
    composerOpen: false
  };

  function ensureFingerprint() {
    let fp = localStorage.getItem(LS_FP);
    if (!fp) {
      fp = `web_${uuid()}`;
      localStorage.setItem(LS_FP, fp);
    }
    return fp;
  }

  /* —— 积分读取（兼容 camel / snake）—— */
  function pickNum(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
      const v = obj[k];
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  }
  function balanceInfo() {
    const pts = state.balance && state.balance.points;
    const available = pickNum(pts, ["availableBalance", "available_balance", "balance"]);
    const held = pickNum(pts, ["heldBalance", "held_balance"]);
    const used = pickNum(pts, ["totalConsumed", "total_consumed"]);
    let total = pickNum(pts, ["totalGranted", "total_granted"]);
    if (total == null && available != null && used != null) total = available + used + (held || 0);
    const label = (pts && pts.label) || "积分";
    return { available, held, used, total, label };
  }

  /* ==================== E. Toast ==================== */

  const toastsBox = $("#toasts");
  function toast(msg, type = "info", ms = 3600) {
    if (!msg) return;
    const t = el("div", `toast t-${type}`,
      icon(type === "ok" ? "check" : type === "err" ? "alert" : "info"),
      el("div", null, msg)
    );
    toastsBox.append(t);
    while (toastsBox.children.length > 4) toastsBox.firstChild.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 280);
    }, ms);
  }

  /* ==================== F. 浮层管理 ==================== */

  const layerRoot = $("#layer");
  const layerStack = [];

  function openLayer(node, opts = {}) {
    const scrim = el("div", "scrim");
    const entry = { node, scrim, onClose: opts.onClose || null };
    scrim.addEventListener("click", () => { if (!opts.persistent) closeLayer(entry); });
    layerRoot.append(scrim, node);
    layerStack.push(entry);
    return entry;
  }
  function closeLayer(entry) {
    const i = layerStack.indexOf(entry);
    if (i < 0) return;
    layerStack.splice(i, 1);
    entry.scrim.remove();
    entry.node.remove();
    if (entry.onClose) entry.onClose();
  }
  function closeTopLayer() {
    const top = layerStack[layerStack.length - 1];
    if (top) { closeLayer(top); return true; }
    return false;
  }

  /* 简单确认框 */
  function confirmBox({ title, message, okText = "确认", danger = false }) {
    return new Promise((resolve) => {
      const modal = el("div", "modal");
      const wrap = el("div", "modal-wrap");
      wrap.append(modal);
      const entry = openLayer(wrap, { persistent: true, onClose: () => resolve(false) });
      const done = (v) => { entry.onClose = null; closeLayer(entry); resolve(v); };
      const okBtn = el("button", `btn btn-lg ${danger ? "btn-danger-soft" : "btn-primary"}`, okText);
      okBtn.addEventListener("click", () => done(true));
      const cancel = el("button", "btn btn-lg btn-ghost", "取消");
      cancel.addEventListener("click", () => done(false));
      modal.append(
        el("div", "modal-head", el("h3", null, title)),
        el("div", "modal-body", message),
        el("div", "modal-foot", el("span", "spacer"), cancel, okBtn)
      );
      wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
      okBtn.focus();
    });
  }

  /* 弹出菜单（参数选择等） */
  let activePop = null;
  function closePop() {
    if (activePop) {
      activePop.pop.remove();
      if (activePop.anchor) activePop.anchor.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", activePop.outside, true);
      activePop = null;
    }
  }
  function openPop(anchor, build, opts = {}) {
    if (activePop && activePop.anchor === anchor) { closePop(); return; }
    closePop();
    const pop = el("div", "pop");
    pop.style.position = "fixed";
    build(pop, closePop);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = Math.min(pop.offsetWidth, window.innerWidth - 16);
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - pop.offsetHeight - 6);
    }
    /* avoid：整体让出某个区域（如指挥条），菜单贴其上缘弹出 */
    if (opts.avoid) {
      const ar = opts.avoid.getBoundingClientRect();
      top = Math.min(top, Math.max(8, ar.top - pop.offsetHeight - 8));
    }
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${top}px`;
    anchor.setAttribute("aria-expanded", "true");
    const outside = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePop();
    };
    document.addEventListener("pointerdown", outside, true);
    activePop = { pop, anchor, outside };
  }

  /* ==================== G. 视图切换 ==================== */

  const views = {
    boot: $("#view-boot"),
    lock: $("#view-lock"),
    studio: $("#view-studio")
  };
  function showView(name) {
    state.view = name;
    for (const [k, node] of Object.entries(views)) node.classList.toggle("hidden", k !== name);
  }

  /* ==================== H. 公告 ==================== */

  function levelInfo(level) {
    const lv = String(level || "").toLowerCase();
    if (lv === "danger") return { label: "重要", cls: "lv-danger", tag: "tag-red" };
    if (lv === "warning") return { label: "提醒", cls: "lv-warning", tag: "tag-yellow" };
    if (lv === "maintenance") return { label: "维护", cls: "lv-maintenance", tag: "tag-blue" };
    if (lv === "success") return { label: "通知", cls: "lv-success", tag: "tag-green" };
    return { label: "公告", cls: "lv-info", tag: "tag-accent" };
  }

  function matchPlacement(a, place) {
    const p = String(a.placement || "all").toLowerCase();
    return p === "all" || p === place;
  }

  function visibleAnnouncements(place) {
    const dismissed = new Set(state.dismissed);
    return state.announcements
      .filter(a => a.dismissible === false || !dismissed.has(a.id))
      .filter(a => matchPlacement(a, place))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }

  function dismissAnnouncement(id) {
    if (!state.dismissed.includes(id)) {
      state.dismissed = [...state.dismissed, id].slice(-200);
      localStorage.setItem(LS_DISMISSED, JSON.stringify(state.dismissed));
    }
    renderAnnouncements();
  }

  function bannerNode(a, { compact = true } = {}) {
    const lv = levelInfo(a.level);
    const banner = el("div", `banner ${lv.cls}`);
    const content = el("div", `b-content${compact ? " clamp" : ""}`, a.content || "");
    const head = el("div", "b-head",
      el("span", `tag ${lv.tag}`, lv.label),
      a.pinned ? el("span", "tag tag-dim", "置顶") : null,
      el("span", "b-title", a.title || "")
    );
    const main = el("div", "b-main", head, content);
    banner.append(el("span", "b-rail"), main);

    if (compact && (a.content || "").length > 60) {
      const more = el("button", "b-more", "展开全文");
      more.addEventListener("click", () => {
        const opened = content.classList.toggle("clamp");
        more.textContent = opened ? "展开全文" : "收起";
      });
      main.append(more);
    }
    if (a.dismissible !== false) {
      const x = el("button", "b-x", icon("x", 11));
      x.title = "不再提示此公告";
      x.addEventListener("click", () => dismissAnnouncement(a.id));
      banner.append(x);
    }
    return banner;
  }

  function renderAnnouncements() {
    /* 锁定页横幅 */
    const gate = $("#gate-banners");
    gate.replaceChildren(...visibleAnnouncements("home").slice(0, 3).map(a => bannerNode(a)));
    /* 创作台横幅 */
    const comp = $("#composer-banners");
    comp.replaceChildren(...visibleAnnouncements("composer").slice(0, 2).map(a => bannerNode(a)));
    /* 铃铛角标：全部有效公告数 */
    const all = state.announcements.filter(a => a.dismissible === false || !state.dismissed.includes(a.id));
    const badge = $("#bell-badge");
    badge.classList.toggle("hidden", all.length === 0);
    badge.textContent = all.length > 9 ? "9+" : String(all.length);
  }

  function openAnnouncementCenter() {
    const drawer = el("div", "drawer");
    const closeBtn = el("button", "icon-btn", icon("x"));
    drawer.append(
      el("div", "drawer-head", el("h3", null, "公告中心"), closeBtn),
      el("div", "drawer-sub", "这里保留当前全部有效公告，已关闭的公告也可以回来查看。"),
    );
    const body = el("div", "drawer-body");
    const list = [...state.announcements].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    if (!list.length) body.append(el("div", "drawer-empty", "暂无公告"));
    else {
      for (const a of list) {
        const node = bannerNode(a, { compact: false });
        if (state.dismissed.includes(a.id)) {
          const head = node.querySelector(".b-head");
          head && head.append(el("span", "tag tag-dim", "已关闭"));
          const x = node.querySelector(".b-x");
          x && x.remove();
        }
        body.append(node);
      }
    }
    drawer.append(body);
    const entry = openLayer(drawer);
    closeBtn.addEventListener("click", () => closeLayer(entry));
  }

  function maybePopupAnnouncement() {
    const place = state.view === "lock" ? "home" : "composer";
    const candidate = state.announcements.find(a =>
      a.popup && !state.dismissed.includes(a.id) && matchPlacement(a, place));
    if (!candidate) return;
    const lv = levelInfo(candidate.level);
    const modal = el("div", "modal");
    const wrap = el("div", "modal-wrap");
    wrap.append(modal);
    const entry = openLayer(wrap, { persistent: true });
    const okBtn = el("button", "btn btn-lg btn-primary", "我知道了");
    okBtn.addEventListener("click", () => closeLayer(entry));
    const noMore = el("button", "btn btn-lg btn-ghost", "不再提示");
    noMore.addEventListener("click", () => { dismissAnnouncement(candidate.id); closeLayer(entry); });
    modal.append(
      el("div", "modal-head", el("span", `tag ${lv.tag}`, lv.label), el("h3", null, candidate.title || "公告")),
      el("div", "modal-body pre", candidate.content || ""),
      el("div", "modal-foot", candidate.dismissible !== false ? noMore : null, el("span", "spacer"), okBtn)
    );
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeLayer(entry); });
  }

  async function loadAnnouncements() {
    try {
      const groups = await Promise.all(["home", "composer"].map(p => api.announcements(p)));
      const seen = new Set();
      const merged = [];
      for (const a of groups.flat()) {
        if (a && typeof a.id === "string" && typeof a.title === "string" && typeof a.content === "string" && !seen.has(a.id)) {
          seen.add(a.id);
          merged.push(a);
        }
      }
      state.announcements = merged.slice(0, 20);
      renderAnnouncements();
      if (state.view !== "boot") maybePopupAnnouncement();
    } catch { /* 公告失败静默 */ }
  }

  /* ==================== I. 积分 ==================== */

  function renderPoints() {
    const { available, label } = balanceInfo();
    $("#pp-label").textContent = label;
    $("#pp-value").textContent = fmtPoints(available);
    renderQuote();
  }

  async function refreshBalance({ silent = false } = {}) {
    if (!state.licenseKey || !state.fingerprint) return;
    const spinner = $("#pp-refresh");
    spinner.classList.add("spin");
    try {
      const data = await api.balance(state.licenseKey, state.fingerprint);
      state.balance = data.balance;
      renderPoints();
      if (!silent) toast("积分已刷新", "ok", 1800);
      if (data.balance && data.balance.valid === false) {
        toast(data.balance.reason || "访问码不可用", "err");
        logout();
      }
    } catch (e) {
      if (!silent) toast(errMsg(e), "err");
    } finally {
      spinner.classList.remove("spin");
    }
  }

  function openBalancePop() {
    const { available, held, used, total, label } = balanceInfo();
    openPop($("#points-pill"), (pop, close) => {
      pop.classList.add("balance-pop");
      const row = (k, v, main) => el("div", "bp-row",
        el("span", "bp-k", k),
        el("span", `bp-v mono${main ? " main" : ""}`, v)
      );
      pop.append(
        row(`可用${label}`, fmtPoints(available), true),
        row("冻结（预扣中）", fmtPoints(held)),
        row("已使用", fmtPoints(used)),
        row("累计获得", fmtPoints(total))
      );
      const refreshBtn = el("button", "btn btn-sm", icon("refresh"), "刷新");
      refreshBtn.addEventListener("click", async () => { close(); await refreshBalance(); });
      const switchBtn = el("button", "btn btn-sm btn-ghost", icon("logout"), "更换访问码");
      switchBtn.addEventListener("click", () => { close(); logout(); });
      pop.append(el("div", "bp-foot", refreshBtn, switchBtn));
    });
  }

  /* ==================== J. 授权流程 ==================== */

  function logout() {
    localStorage.removeItem(LS_KEY);
    stopPolling();
    state.licenseKey = "";
    state.balance = null;
    state.tasks = [];
    state.assets = [];
    state.recentAssets = [];
    $("#gate-key").value = "";
    setGateMsg("", "");
    showView("lock");
    renderAnnouncements();
  }

  function setGateMsg(text, kind) {
    const box = $("#gate-msg");
    box.textContent = text;
    box.className = `gate-msg${kind ? " " + kind : ""}`;
  }

  async function handleActivate(ev) {
    ev.preventDefault();
    const key = $("#gate-key").value.trim();
    if (!key) { setGateMsg("请先输入访问码", "err"); return; }
    const go = $("#gate-go");
    go.disabled = true;
    $("#gate-go-text").textContent = "正在验证…";
    setGateMsg("", "");
    try {
      const data = await api.activate(key, state.fingerprint);
      if (!data.balance || data.balance.valid === false) {
        throw new Error((data.balance && data.balance.reason) || "访问码不可用");
      }
      state.licenseKey = key;
      state.balance = data.balance;
      localStorage.setItem(LS_KEY, key);
      setGateMsg("验证成功，正在进入工作台…", "ok");
      toast("验证成功，欢迎进入 HS AI 视频工作台", "ok");
      enterStudio();
    } catch (e) {
      localStorage.removeItem(LS_KEY);
      setGateMsg(errMsg(e), "err");
    } finally {
      go.disabled = false;
      $("#gate-go-text").textContent = "启动创作台";
    }
  }

  /* ==================== K. 启动 ==================== */

  function applyConfigDefaults() {
    const cfg = state.config;
    if (!cfg) return;
    const models = cfg.modelOptions || [];
    const tiers = cfg.imageModelOptions || [];
    const dm = cfg.defaultModel || "";
    const dt = cfg.defaultImageModel || "";
    state.videoModel = models.includes(dm) ? dm : (models[0] || "");
    state.imageModel = tiers.includes(dt) ? dt : (tiers[0] || "");
    /* 时长适配当前模型 */
    const opts = durationOptions();
    if (!opts.includes(state.duration)) {
      state.duration = opts.includes(DEFAULT_DURATION) ? DEFAULT_DURATION : (opts[opts.length - 1] || DEFAULT_DURATION);
    }
    const lockModel = $("#lock-foot-model");
    if (lockModel && state.videoModel) lockModel.textContent = state.videoModel.toUpperCase();
  }

  async function boot() {
    state.fingerprint = ensureFingerprint();
    state.dismissed = (readJson(LS_DISMISSED, []) || []).filter(x => typeof x === "string");
    const stored = localStorage.getItem(LS_KEY) || "";

    loadAnnouncements();

    try {
      state.config = await api.config();
      applyConfigDefaults();
    } catch (e) {
      toast(errMsg(e), "err");
    }

    if (!stored) { showView("lock"); return; }

    try {
      const data = await api.balance(stored, state.fingerprint);
      state.balance = data.balance;
      if (data.balance && data.balance.valid) {
        state.licenseKey = stored;
        $("#gate-key").value = stored;
        enterStudio();
      } else {
        localStorage.removeItem(LS_KEY);
        showView("lock");
        setGateMsg((data.balance && data.balance.reason) || "访问码不可用", "err");
      }
    } catch (e) {
      localStorage.removeItem(LS_KEY);
      showView("lock");
      setGateMsg(errMsg(e), "err");
    }
  }

  function enterStudio() {
    showView("studio");
    state.tasks = sanitizeTasks(readJson(taskStoreKey(state.licenseKey), []));
    renderPoints();
    renderMode();
    renderAssets();
    renderParams();
    renderPricing();
    renderQuote();
    renderTasks();
    renderAnnouncements();
    maybePopupAnnouncement();
    refreshLibrary({ silent: true });
    setComposer(true, { instant: true });
    renderBarPrompt();
    startPolling();
  }

  /* ==================== L. 创作面板：模式与参数 ==================== */

  const promptEl = $("#prompt");

  function isFLF() { return state.mode === "video" && state.refMode === "first_last_frame"; }
  function maxImages() { return state.mode === "image" ? 9 : (isFLF() ? 2 : 9); }
  function audioAllowed() { return state.mode === "video" && !isFLF(); }

  function videoModels() { return (state.config && state.config.models) || []; }
  function imageModels() { return (state.config && state.config.imageModels) || []; }
  function modelOptions() { return state.config ? (state.config.modelOptions || []) : FALLBACK_MODELS; }
  function tierOptions() { return state.config ? (state.config.imageModelOptions || []) : FALLBACK_TIERS; }
  function currentVideoModel() {
    return videoModels().find(m => m.name === state.videoModel || m.model === state.videoModel) || null;
  }
  function currentImageModel() {
    return imageModels().find(m => m.name === state.imageModel || m.tier === state.imageModel || m.model === state.imageModel) || null;
  }
  function durationOptions() {
    const m = currentVideoModel();
    return (m && m.durationOptions && m.durationOptions.length) ? m.durationOptions : FALLBACK_DURATIONS;
  }

  function billingOf(m) {
    if (!m) return "per_second";
    if (m.billingMode === "per_task" || (!m.pointsPerSecond && m.pointsPerTask)) return "per_task";
    return m.billingMode || "per_second";
  }

  function videoQuote() {
    const m = currentVideoModel();
    if (!m) return null;
    const secs = Number(String(state.duration).replace(/s$/i, "")) || 0;
    if (m.durationOptions && m.durationOptions.length && !m.durationOptions.includes(`${secs}s`)) return null;
    const billing = billingOf(m);
    const total = billing === "per_task" ? (m.pointsPerTask || 0) : (m.pointsPerSecond || 0) * secs;
    return {
      modelName: m.name, durationSeconds: secs, billingMode: billing,
      pointsPerSecond: m.pointsPerSecond || 0, pointsPerTask: m.pointsPerTask || 0,
      totalPoints: Math.round(total * 100) / 100
    };
  }
  function imageQuote() {
    const m = currentImageModel();
    if (!m) return null;
    return {
      modelName: m.name, billingMode: "per_task",
      pointsPerTask: m.pointsPerTask || 0,
      totalPoints: Math.round((m.pointsPerTask || 0) * 100) / 100
    };
  }
  function activeQuote() { return state.mode === "image" ? imageQuote() : videoQuote(); }
  function hasEnoughPoints() {
    const { available } = balanceInfo();
    const q = activeQuote();
    return available == null || q == null || available >= q.totalPoints;
  }

  function renderMode() {
    $$("button[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === state.mode));
    const isImg = state.mode === "image";
    const winTitle = $("#win-title");
    if (winTitle) winTitle.textContent = isImg ? "图片生成" : "视频生成";
    promptEl.placeholder = isImg
      ? "描述你想生成的图片。可上传参考图后输入 @ 选择，例如：让 @图片1 变成赛博朋克海报"
      : "描述你想生成的视频。输入 @ 可引用已添加的图片 / 音频素材";
    $("#assets-title").textContent = isImg ? "参考图片" : "参考素材";
    $("#btn-up-audio").classList.toggle("hidden", !audioAllowed());
    $("#go-text").textContent = isImg ? "生成图片" : "开始生成";
    renderBarPrompt();
    renderDzTip();
    renderAssets();
    renderParams();
    renderPricing();
    renderQuote();
    renderTasks();
  }

  function renderDzTip() {
    const tip = $("#dz-tip");
    tip.replaceChildren();
    if (state.mode === "image") {
      tip.append("拖入或 Ctrl+V 粘贴图片；不传参考图即为文生图，传图后输入 ", el("span", "at", "@"), " 可在提示词中引用");
    } else if (isFLF()) {
      tip.append(el("b", null, "首尾帧模式："), "第 1 张为首帧、第 2 张为尾帧（最多 2 张），不支持音频");
    } else {
      tip.append("拖入图片 / 音频，或 Ctrl+V 粘贴截图；在提示词里输入 ", el("span", "at", "@"), " 可直接引用素材");
    }
  }

  /* —— 参数行 —— */

  function ratioMark(ratio) {
    const [w, h] = String(ratio).split(":").map(Number);
    const mark = el("span", "ratio-mark");
    const box = el("i");
    const max = 18, maxH = 14;
    let bw = max, bh = max * (h / w);
    if (bh > maxH) { bh = maxH; bw = maxH * (w / h); }
    box.style.width = `${Math.max(6, bw)}px`;
    box.style.height = `${Math.max(6, bh)}px`;
    mark.append(box);
    return mark;
  }

  function paramButton({ label, value, disabled, onOpen, compact }) {
    const btn = el("button", "param");
    btn.type = "button";
    btn.title = label;
    if (disabled) btn.disabled = true;
    const caret = icon("chevron", 11);
    caret.setAttribute("class", "caret icon");
    if (!compact) btn.append(el("span", "p-label", label));
    btn.append(el("span", "p-value", value || "暂无可选"), caret);
    if (!disabled) btn.addEventListener("click", () => onOpen(btn));
    return btn;
  }

  function menuItems(pop, close, items, current, onPick) {
    for (const it of items) {
      if (it.sep) { pop.append(el("div", "pop-sep")); continue; }
      const btn = el("button", `pop-item${it.value === current ? " on" : ""}`);
      btn.type = "button";
      if (it.mark) btn.append(it.mark);
      const main = el("div", "pi-main", el("div", "pi-title", it.title));
      if (it.sub) main.append(el("div", "pi-sub", it.sub));
      btn.append(main);
      if (it.price) btn.append(el("span", "pi-price", it.price));
      btn.addEventListener("click", () => { onPick(it.value); close(); });
      pop.append(btn);
    }
  }

  function renderParams() {
    renderParamsInto($("#params"), false);
    renderBarSummary();
    if (barPanelOpen) buildBarPanel();
  }

  /* —— 指挥条参数摘要 + 上弹面板 —— */

  function renderBarSummary() {
    const node = $("#bar-settings-text");
    if (!node) return;
    node.textContent = state.mode === "image"
      ? `${state.imageModel || "档位"} · ${state.imageRatio}`
      : `${state.videoModel || "模型"} · ${state.duration} · ${state.videoRatio} · ${state.refMode === "first_last_frame" ? "首尾帧" : "多模态"}`;
  }

  let barPanelOpen = false;

  function panelGroups() {
    const apply = (fn) => (v) => {
      fn(v);
      renderMode();   /* 全链路刷新：参数/定价/报价/提示/任务过滤 */
    };
    if (state.mode === "image") {
      return [
        {
          label: "档位",
          opts: tierOptions().map(n => {
            const m = imageModels().find(x => x.name === n);
            return { v: n, t: n, tip: m ? `${m.description || ""} ${fmtPoints(m.pointsPerTask)} ${balanceInfo().label}/张`.trim() : "" };
          }),
          cur: state.imageModel,
          pick: apply(v => { state.imageModel = v; })
        },
        { label: "比例", opts: IMAGE_RATIOS.map(r => ({ v: r, t: r })), cur: state.imageRatio, pick: apply(v => { state.imageRatio = v; }) }
      ];
    }
    return [
      {
        label: "模型",
        opts: modelOptions().map(n => {
          const m = videoModels().find(x => x.name === n);
          const price = m ? (billingOf(m) === "per_task"
            ? `${fmtPoints(m.pointsPerTask)} ${balanceInfo().label}/次`
            : `${fmtPoints(m.pointsPerSecond)} ${balanceInfo().label}/秒`) : "";
          return { v: n, t: n, tip: `${(m && m.description) || ""} ${price}`.trim() };
        }),
        cur: state.videoModel,
        pick: apply(v => {
          state.videoModel = v;
          const opts = durationOptions();
          if (!opts.includes(state.duration)) {
            state.duration = opts.includes(DEFAULT_DURATION) ? DEFAULT_DURATION : opts[0];
          }
        })
      },
      { label: "时长", opts: durationOptions().map(d => ({ v: d, t: d })), cur: state.duration, pick: apply(v => { state.duration = v; }) },
      { label: "比例", opts: VIDEO_RATIOS.map(r => ({ v: r, t: r })), cur: state.videoRatio, pick: apply(v => { state.videoRatio = v; }) },
      {
        label: "参考",
        opts: [{ v: "multimodal", t: "多模态" }, { v: "first_last_frame", t: "首尾帧" }],
        cur: state.refMode,
        pick: apply(v => { state.refMode = v; })
      }
    ];
  }

  function buildBarPanel() {
    const panel = $("#bar-panel");
    if (!panel) return;
    panel.replaceChildren();
    for (const g of panelGroups()) {
      const chips = el("div", "bp-chips");
      for (const o of g.opts) {
        const chip = el("button", `bp-chip${o.v === g.cur ? " on" : ""}`, o.t);
        chip.type = "button";
        if (o.tip) chip.title = o.tip;
        chip.addEventListener("click", () => g.pick(o.v));
        chips.append(chip);
      }
      panel.append(el("div", "bp-group", el("span", "bp-label", g.label), chips));
    }
  }

  function positionBarPanel() {
    const panel = $("#bar-panel");
    const chip = $("#bar-settings");
    const bar = $(".cmdbar");
    if (!panel || !chip || !bar) return;
    /* 左缘对齐摘要 chip，越界时收回；底缘贴住指挥条实际顶部（条会随输入长高） */
    const r = chip.getBoundingClientRect();
    const w = Math.min(600, window.innerWidth - 16);
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    panel.style.bottom = `${window.innerHeight - bar.getBoundingClientRect().top + 12}px`;
  }

  function setBarPanel(open) {
    barPanelOpen = !!open;
    const panel = $("#bar-panel");
    const chip = $("#bar-settings");
    if (!panel || !chip) return;
    chip.classList.toggle("open", barPanelOpen);
    if (barPanelOpen) {
      buildBarPanel();
      positionBarPanel();
    }
    panel.classList.toggle("show", barPanelOpen);
  }

  function renderParamsInto(box, compact) {
    if (!box) return;
    box.replaceChildren();
    const unit = balanceInfo().label;

    if (state.mode === "video") {
      const models = modelOptions();
      box.append(paramButton({
        compact,
        label: "模型", value: state.videoModel || "暂无可用模型", disabled: !models.length,
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, videoModels().filter(m => models.includes(m.name)).map(m => ({
            value: m.name, title: m.name, sub: m.description || "",
            price: billingOf(m) === "per_task" ? `${fmtPoints(m.pointsPerTask)} ${unit}/次` : `${fmtPoints(m.pointsPerSecond)} ${unit}/秒`
          })), state.videoModel, (v) => {
            state.videoModel = v;
            const opts = durationOptions();
            if (!opts.includes(state.duration)) state.duration = opts.includes(DEFAULT_DURATION) ? DEFAULT_DURATION : opts[0];
            renderParams(); renderPricing(); renderQuote();
          });
        })
      }));

      box.append(paramButton({
        compact,
        label: "时长", value: state.duration,
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, durationOptions().map(d => ({ value: d, title: d })), state.duration, (v) => {
            state.duration = v;
            renderParams(); renderQuote();
          });
        })
      }));

      box.append(paramButton({
        compact,
        label: "比例", value: state.videoRatio,
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, VIDEO_RATIOS.map(r => ({ value: r, title: r, mark: ratioMark(r) })), state.videoRatio, (v) => {
            state.videoRatio = v;
            renderParams(); renderQuote();
          });
        })
      }));

      box.append(paramButton({
        compact,
        label: "参考", value: state.refMode === "first_last_frame" ? "首尾帧" : "多模态",
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, [
            { value: "multimodal", title: "多模态参考", sub: "图片 ×9 + 音频 ×3，自由引用" },
            { value: "first_last_frame", title: "首尾帧", sub: "1-2 张图片定首尾画面，不支持音频" }
          ], state.refMode, (v) => {
            state.refMode = v;
            renderMode();
          });
        })
      }));
    } else {
      const tiers = tierOptions();
      box.append(paramButton({
        compact,
        label: "档位", value: state.imageModel || "暂无图片档位", disabled: !tiers.length,
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, imageModels().filter(m => tiers.includes(m.name)).map(m => ({
            value: m.name, title: m.name, sub: m.description || "",
            price: `${fmtPoints(m.pointsPerTask)} ${unit}/张`
          })), state.imageModel, (v) => {
            state.imageModel = v;
            renderParams(); renderPricing(); renderQuote();
          });
        })
      }));

      box.append(paramButton({
        compact,
        label: "比例", value: state.imageRatio,
        onOpen: (anchor) => openPop(anchor, (pop, close) => {
          menuItems(pop, close, IMAGE_RATIOS.map(r => ({ value: r, title: r, mark: ratioMark(r) })), state.imageRatio, (v) => {
            state.imageRatio = v;
            renderParams(); renderQuote();
          });
        })
      }));
    }
  }

  function renderPricing() {
    const box = $("#pricing");
    box.replaceChildren();
    const cfg = state.config;
    const unit = balanceInfo().label;
    const list = state.mode === "image" ? imageModels() : videoModels();
    const title = state.mode === "image" ? "图片档位与定价" : "模型与定价";

    const toggle = el("button", "pn-toggle", `${title}（${list.length} 个）`, " ", state.pricingOpen ? "收起 ↑" : "展开 ↓");
    toggle.type = "button";
    toggle.addEventListener("click", () => { state.pricingOpen = !state.pricingOpen; renderPricing(); });

    const hint = cfg && cfg.costHint ? cfg.costHint : "";
    box.append(el("span", null, hint ? hint + " · " : ""), toggle);

    if (state.pricingOpen) {
      const table = el("div", "pricing-table");
      if (!list.length) {
        table.append(el("div", "pt-row", el("span", "pt-name", state.mode === "image"
          ? "暂无可用图片档位，请联系管理员开启后再使用。"
          : "暂无可用视频模型，请联系管理员开启后再使用。")));
      }
      for (const m of list) {
        table.append(el("div", "pt-row",
          el("span", "pt-name", m.name),
          m.description ? el("span", "pt-desc", m.description) : null,
          el("span", "pt-price", billingOf(m) === "per_task"
            ? `${fmtPoints(m.pointsPerTask)} ${unit}/${state.mode === "image" ? "张" : "次"}`
            : `${fmtPoints(m.pointsPerSecond)} ${unit}/秒`)
        ));
      }
      box.append(table);
    }
  }

  function renderQuote() {
    if (state.view !== "studio") return;
    const row = $("#quote-row");
    row.replaceChildren();
    const q = activeQuote();
    const { available, label } = balanceInfo();
    const enough = hasEnoughPoints();
    row.classList.toggle("insufficient", !enough);

    if (!q) {
      row.append(el("span", null, "选择模型后查看预计积分"));
    } else {
      if (state.mode === "image") row.append(el("span", "tag tag-dim", imageCount() ? "图生图" : "文生图"));
      row.append(el("span", null, "本次预计"));
      if (q.billingMode !== "per_task" && q.durationSeconds) {
        row.append(el("span", "q-calc", `${fmtPoints(q.pointsPerSecond)}/秒 × ${q.durationSeconds}s =`));
      }
      row.append(
        el("span", "q-total", fmtPoints(q.totalPoints)),
        el("span", "q-unit", label),
        el("span", "q-stage", (state.config && state.config.chargeStage) === "hold" ? "提交预扣 · 失败自动释放" : "")
      );
    }

    const warn = $("#commit-warn");
    const problems = collectProblems();
    if (!enough && q) problems.unshift(`${label}不足，无法提交本次任务`);
    if (problems.length) {
      warn.classList.remove("hidden");
      warn.textContent = problems[0];
    } else {
      warn.classList.add("hidden");
      warn.textContent = "";
    }

    $("#btn-go").disabled = state.submitting || !!problems.length || !q || !enough;

    const barQuote = $("#bar-quote");
    if (barQuote) {
      barQuote.classList.toggle("hidden", !q);
      barQuote.classList.toggle("insufficient", !enough);
      if (q) barQuote.textContent = `${fmtPoints(q.totalPoints)} ${label}`;
    }
  }

  /* ==================== M. 素材管理 ==================== */

  function imageCount() { return state.urlImages.length + state.localImages.length; }
  function audioCount() { return state.urlAudios.length + state.localAudios.length; }
  function pendingBytes() {
    const auds = audioAllowed() ? state.localAudios : [];
    return [...state.localImages, ...auds].reduce((s, x) => s + (x.size || 0), 0);
  }
  function localAudioSeconds() {
    return state.localAudios.reduce((s, a) => s + (Number.isFinite(a.duration) ? a.duration : 0), 0);
  }
  function refModeText() { return isFLF() ? "首尾帧" : (state.mode === "image" ? "图片生成" : "多模态参考"); }

  function collectProblems() {
    const list = [];
    const imgMax = maxImages();
    if (imageCount() > imgMax) list.push(`${refModeText()}模式参考图最多支持 ${imgMax} 张，当前已有 ${imageCount()} 张`);
    if (state.mode === "video") {
      if (isFLF() && audioCount() > 0) list.push("首尾帧模式不支持音频，请清空音频或切换到多模态参考");
      if (!isFLF() && audioCount() > MAX_AUDIOS) list.push(`音频最多支持 ${MAX_AUDIOS} 段`);
      if (!isFLF() && localAudioSeconds() > AUD_TOTAL_S) list.push(`音频总时长不能超过 ${AUD_TOTAL_S}s`);
    }
    if (pendingBytes() > BATCH_MAX_BYTES) list.push(`本地待上传素材总大小不能超过 ${fmtBytes(BATCH_MAX_BYTES)}`);
    if (state.urlImages.some(u => !isHttpUrl(u))) list.push("图片 URL 仅支持 http/https");
    if (audioAllowed() && state.urlAudios.some(a => !isHttpUrl(a.url))) list.push("音频 URL 仅支持 http/https");
    if (state.localImages.some(i => i.maskStatus === "detecting")) list.push("图片正在自动打码，请等待完成后再生成");
    const auds = audioAllowed() ? state.localAudios : [];
    if ([...state.localImages, ...auds].some(x => x.error)) list.push("请先移除或更换校验失败的参考素材");
    return list;
  }

  function renderAssetHint() {
    const parts = [`图片 ${imageCount()}/${maxImages()}`];
    if (audioAllowed()) parts.push(`音频 ${audioCount()}/${MAX_AUDIOS}`);
    const bytes = pendingBytes();
    if (bytes > 0) parts.push(`${fmtBytes(bytes)} / ${fmtBytes(BATCH_MAX_BYTES)}`);
    if (audioAllowed()) {
      const secs = localAudioSeconds();
      if (secs > 0) parts.push(`${Math.round(secs * 10) / 10}s / ${AUD_TOTAL_S}s`);
    }
    $("#assets-hint").textContent = parts.join(" · ");
  }

  function renderAssets() {
    if (state.view !== "studio") return;
    renderAssetHint();

    /* 图片缩略图 */
    const thumbs = $("#thumbs");
    thumbs.replaceChildren();
    let no = 0;

    state.urlImages.forEach((url, i) => {
      no += 1;
      const t = el("div", "thumb is-url");
      const img = el("img");
      img.src = url;
      img.loading = "lazy";
      img.alt = `参考图 ${no}`;
      const x = el("button", "th-x", icon("x", 11));
      x.title = "移除";
      x.addEventListener("click", () => {
        state.urlImages = state.urlImages.filter((_, j) => j !== i);
        renderAssets(); renderQuote();
      });
      t.append(img, el("span", "th-no", `@图片${no}`), x);
      thumbs.append(t);
    });

    state.localImages.forEach((it) => {
      no += 1;
      const t = el("div", `thumb${it.error ? " is-err" : ""}`);
      const img = el("img");
      img.src = it.previewUrl;
      img.alt = it.name;
      const x = el("button", "th-x", icon("x", 11));
      x.title = "移除";
      x.addEventListener("click", () => removeLocalImage(it.id));
      t.append(img, el("span", "th-no", `@图片${no}`), x);

      if (it.error) {
        t.append(el("span", "th-state", it.error));
      } else if (it.maskStatus === "detecting") {
        t.append(el("span", "th-state detecting", "检测中…"));
      } else {
        if (it.maskStatus === "masked") t.append(el("span", "th-state masked", `已打码 ${it.faceCount || 0} 张人脸`));
        else if (it.edited) t.append(el("span", "th-state masked", "已标注"));
        const foot = el("div", "th-foot");
        const editBtn = el("button", "th-act", "编辑标注");
        editBtn.addEventListener("click", () => openEditor(it));
        const maskBtn = el("button", "th-act", "自动马赛克");
        maskBtn.addEventListener("click", () => autoMask(it));
        foot.append(editBtn, maskBtn);
        t.append(foot);
      }
      thumbs.append(t);
    });
    thumbs.classList.toggle("hidden", no === 0);

    /* 音频条：视频模式始终可见（首尾帧下也要能删），图片模式隐藏 */
    const rows = $("#audio-rows");
    rows.replaceChildren();
    let an = 0;
    if (state.mode === "video") {
      state.urlAudios.forEach((a, i) => {
        an += 1;
        const row = el("div", "audio-row");
        const x = el("button", "ar-x", icon("x", 11));
        x.addEventListener("click", () => {
          state.urlAudios = state.urlAudios.filter((_, j) => j !== i);
          renderAssets(); renderQuote();
        });
        row.append(
          el("span", "ar-no", `@音频${an}`),
          icon("link", 12),
          el("span", "ar-name", a.name || a.url),
          a.duration ? el("span", "ar-dur", `${a.duration}s`) : null,
          x
        );
        rows.append(row);
      });
      state.localAudios.forEach((a) => {
        an += 1;
        const row = el("div", `audio-row${a.error ? " is-err" : ""}`);
        const x = el("button", "ar-x", icon("x", 11));
        x.addEventListener("click", () => removeLocalAudio(a.id));
        row.append(
          el("span", "ar-no", `@音频${an}`),
          icon("music", 12),
          el("span", "ar-name", a.name),
          a.error ? el("span", "ar-err", a.error) : el("span", "ar-dur", `${Math.round((a.duration || 0) * 10) / 10}s · ${fmtBytes(a.size)}`),
          x
        );
        rows.append(row);
      });
    }
    rows.classList.toggle("hidden", an === 0);

    /* 校验警告 */
    const warns = $("#asset-warns");
    warns.replaceChildren();
    for (const p of collectProblems().slice(0, 2)) {
      warns.append(el("div", "warn-line", icon("alert", 13), el("span", null, p)));
    }

    renderBarAttach();
    renderQuote();
  }

  function removeLocalImage(id) {
    const it = state.localImages.find(x => x.id === id);
    if (it) URL.revokeObjectURL(it.previewUrl);
    state.localImages = state.localImages.filter(x => x.id !== id);
    renderAssets();
  }
  function removeLocalAudio(id) {
    const it = state.localAudios.find(x => x.id === id);
    if (it) URL.revokeObjectURL(it.previewUrl);
    state.localAudios = state.localAudios.filter(x => x.id !== id);
    renderAssets();
  }

  /* —— 文件读取与校验 —— */

  function readImageSize(file, objectUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error("图片无法读取，请更换文件"));
      img.src = objectUrl;
    });
  }
  function readAudioDuration(objectUrl) {
    return new Promise((resolve, reject) => {
      const a = document.createElement("audio");
      const clean = () => { a.removeAttribute("src"); a.load(); };
      a.preload = "metadata";
      a.onloadedmetadata = () => {
        const d = a.duration;
        clean();
        Number.isFinite(d) ? resolve(d) : reject(new Error("音频时长无法读取"));
      };
      a.onerror = () => { clean(); reject(new Error("音频无法读取，请更换文件")); };
      a.src = objectUrl;
    });
  }

  async function validateImage(file, objectUrl) {
    if (!isImageFile(file)) throw new Error("格式不支持，仅支持 jpeg/png/webp/bmp/tiff/gif");
    if (file.size <= 0) throw new Error("文件为空");
    if (file.size >= IMG_MAX_BYTES) throw new Error(`单张图片需小于 ${fmtBytes(IMG_MAX_BYTES)}`);
    const { width, height } = await readImageSize(file, objectUrl);
    if (width < IMG_MIN_PX || width > IMG_MAX_PX || height < IMG_MIN_PX || height > IMG_MAX_PX) {
      throw new Error(`宽高需要在 ${IMG_MIN_PX}-${IMG_MAX_PX}px 之间`);
    }
    const ar = width / Math.max(1, height);
    if (ar <= IMG_AR_MIN || ar >= IMG_AR_MAX) throw new Error(`宽高比需要在 ${IMG_AR_MIN}-${IMG_AR_MAX} 之间`);
    return { width, height };
  }

  async function addImages(files) {
    const list = Array.from(files || []);
    if (!list.length || state.submitting) return;
    const imgMax = maxImages();
    if (imageCount() + list.length > imgMax) {
      toast(`${refModeText()}模式参考图最多支持 ${imgMax} 张，当前已有 ${imageCount()} 张`, "err");
      return;
    }
    const added = [];
    for (const file of list) {
      const previewUrl = URL.createObjectURL(file);
      const item = {
        id: uuid(), file, previewUrl,
        name: file.name || "image", size: file.size, type: file.type || "image",
        maskStatus: "none"
      };
      try {
        const dim = await validateImage(file, previewUrl);
        item.width = dim.width;
        item.height = dim.height;
      } catch (e) {
        item.error = errMsg(e);
      }
      added.push(item);
    }
    state.localImages = [...state.localImages, ...added];
    if (pendingBytes() > BATCH_MAX_BYTES) {
      const msg = `待上传素材总大小不能超过 ${fmtBytes(BATCH_MAX_BYTES)}`;
      for (const it of added) if (!it.error) it.error = msg;
    }
    const ok = added.filter(x => !x.error).length;
    const bad = added.length - ok;
    toast(bad ? `已添加 ${ok} 张图片，${bad} 张需处理；素材会在点击生成时上传` : `已添加 ${ok} 张图片，点击生成时再上传`, bad ? "err" : "ok");
    renderAssets();
  }

  async function addAudios(files) {
    const list = Array.from(files || []);
    if (!list.length || state.submitting) return;
    if (state.mode === "image") { toast("图片生成暂不支持音频素材，请选择图片素材", "err"); return; }
    if (isFLF()) { toast("首尾帧模式只支持图片，不支持音频；如需音频请切换到多模态参考", "err"); return; }
    if (audioCount() + list.length > MAX_AUDIOS) {
      toast(`音频最多支持 ${MAX_AUDIOS} 段，当前已有 ${audioCount()} 段`, "err");
      return;
    }
    const added = [];
    for (const file of list) {
      const previewUrl = URL.createObjectURL(file);
      const item = { id: uuid(), file, previewUrl, name: file.name || "audio", size: file.size };
      try {
        if (!isAudioFile(file)) throw new Error("格式不支持，仅支持 wav/mp3");
        if (file.size <= 0) throw new Error("文件为空");
        if (file.size >= AUD_MAX_BYTES) throw new Error(`单段音频需小于 ${fmtBytes(AUD_MAX_BYTES)}`);
        const dur = await readAudioDuration(previewUrl);
        item.duration = Math.round(dur * 10) / 10;
        if (dur < AUD_MIN_S || dur > AUD_MAX_S) throw new Error(`单段音频时长需要在 ${AUD_MIN_S}-${AUD_MAX_S}s 之间`);
      } catch (e) {
        item.error = errMsg(e);
      }
      added.push(item);
    }
    const next = [...state.localAudios, ...added];
    if (next.reduce((s, a) => s + (Number.isFinite(a.duration) ? a.duration : 0), 0) > AUD_TOTAL_S) {
      for (const it of added) if (!it.error) it.error = `音频总时长不能超过 ${AUD_TOTAL_S}s`;
    }
    state.localAudios = next;
    if (pendingBytes() > BATCH_MAX_BYTES) {
      const msg = `待上传素材总大小不能超过 ${fmtBytes(BATCH_MAX_BYTES)}`;
      for (const it of added) if (!it.error) it.error = msg;
    }
    const ok = added.filter(x => !x.error).length;
    const bad = added.length - ok;
    toast(bad ? `已添加 ${ok} 段音频，${bad} 段需处理；素材会在点击生成时上传` : `已添加 ${ok} 段音频，点击生成时再上传`, bad ? "err" : "ok");
    renderAssets();
  }

  async function addDroppedFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const images = list.filter(isImageFile);
    const audios = list.filter(f => !isImageFile(f) && isAudioFile(f));
    const unsupported = list.length - images.length - audios.length;
    if (unsupported > 0) toast(`${unsupported} 个文件格式暂不支持，仅支持图片、mp3、wav`, "err");
    if (images.length) await addImages(images);
    if (audios.length) {
      if (state.mode === "image") toast("图片生成暂不支持音频，已忽略音频文件", "err");
      else await addAudios(audios);
    }
  }

  /* —— URL 粘贴模态 —— */

  function openUrlModal() {
    const modal = el("div", "modal url-modal");
    const wrap = el("div", "modal-wrap");
    wrap.append(modal);
    const entry = openLayer(wrap, { persistent: true });

    const imgArea = el("textarea");
    imgArea.placeholder = "https://example.com/a.png";
    imgArea.value = state.urlImages.join("\n");
    const audArea = el("textarea");
    audArea.placeholder = "https://example.com/music.mp3";
    audArea.value = state.urlAudios.map(a => a.url).join("\n");

    const body = el("div", "modal-body");
    body.append(
      el("div", "um-label", "图片 URL"),
      imgArea,
      el("div", "um-hint", "每行一个图片直链。提示词可写 @图片1、@image1 指定位置。")
    );
    if (audioAllowed()) {
      body.append(
        el("div", "um-label", "音频 URL"),
        audArea,
        el("div", "um-hint", "每行一个音频直链（mp3/wav）。提示词可写 @音频1、@audio1。")
      );
    } else if (state.mode === "video") {
      body.append(el("div", "um-hint", "首尾帧模式不支持音频。"));
    }

    const okBtn = el("button", "btn btn-lg btn-primary", "确定");
    okBtn.addEventListener("click", () => {
      state.urlImages = splitLines(imgArea.value);
      if (audioAllowed()) {
        const olds = new Map(state.urlAudios.map(a => [a.url, a]));
        state.urlAudios = splitLines(audArea.value).map(u => olds.get(u) || { url: u });
      }
      closeLayer(entry);
      renderAssets();
    });
    const cancel = el("button", "btn btn-lg btn-ghost", "取消");
    cancel.addEventListener("click", () => closeLayer(entry));

    modal.append(
      el("div", "modal-head", el("h3", null, "粘贴素材 URL"),),
      body,
      el("div", "modal-foot", el("span", "spacer"), cancel, okBtn)
    );
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeLayer(entry); });
    imgArea.focus();
  }

  /* ==================== N. @ 引用补全 ==================== */

  const mentionBox = $("#mention");
  /* 传送到 body：创作器窗口 overflow:hidden + backdrop-filter 会裁剪/劫持内部弹层 */
  document.body.append(mentionBox);
  let mentionState = null; // {start,end,query,index}

  function positionMention() {
    if (mentionBox.classList.contains("hidden")) return;
    const wrap = promptEl.closest(".prompt-wrap");
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    mentionBox.style.left = `${Math.max(8, r.left + 8)}px`;
    mentionBox.style.width = `${Math.max(220, r.width - 16)}px`;
    const mh = Math.min(mentionBox.scrollHeight, 260);
    const below = r.bottom + 6;
    if (below + mh > window.innerHeight - 8 && r.top - mh - 6 > 8) {
      mentionBox.style.top = `${r.top - mh - 6}px`;   /* 下方放不下时翻到上方 */
    } else {
      mentionBox.style.top = `${below}px`;
    }
  }

  function mentionRefs() {
    const refs = [];
    let n = 0;
    for (const url of state.urlImages) { n += 1; refs.push({ kind: "image", label: `@图片${n}`, name: url, thumb: url }); }
    for (const it of state.localImages) { n += 1; refs.push({ kind: "image", label: `@图片${n}`, name: it.name, thumb: it.previewUrl }); }
    let a = 0;
    if (audioAllowed()) {
      for (const it of state.urlAudios) { a += 1; refs.push({ kind: "audio", label: `@音频${a}`, name: it.name || it.url }); }
      for (const it of state.localAudios) { a += 1; refs.push({ kind: "audio", label: `@音频${a}`, name: it.name }); }
    }
    return refs;
  }

  function renderMention() {
    if (!mentionState) { mentionBox.classList.add("hidden"); return; }
    const q = mentionState.query.toLowerCase();
    const refs = mentionRefs().filter(r => !q || r.label.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q));
    mentionBox.replaceChildren();
    if (!refs.length) {
      mentionBox.append(el("div", "mention-empty",
        "暂无可引用素材。先上传或粘贴图片 / 音频 URL，再输入 @ 选择。"));
    } else {
      mentionBox.append(el("div", "mention-head", "选择引用素材，插入后自动写成 @图片1 / @音频1"));
      mentionState.index = Math.min(mentionState.index, refs.length - 1);
      refs.forEach((r, i) => {
        const item = el("button", `mention-item${i === mentionState.index ? " hover" : ""}`);
        item.type = "button";
        const thumb = el("span", "mi-thumb");
        if (r.thumb) {
          const img = el("img"); img.src = r.thumb; thumb.append(img);
        } else thumb.append(icon("music", 13));
        item.append(thumb, el("span", "mi-label", r.label), el("span", "mi-name", r.name));
        item.addEventListener("pointerdown", (e) => { e.preventDefault(); insertMention(r); });
        mentionBox.append(item);
      });
      mentionState.refs = refs;
    }
    mentionBox.classList.remove("hidden");
    positionMention();
  }

  function updateMention() {
    const pos = promptEl.selectionStart || 0;
    const m = promptEl.value.slice(0, pos).match(/@([^@\s]{0,20})$/);
    if (!m) { mentionState = null; renderMention(); return; }
    mentionState = { start: pos - m[0].length, end: pos, query: m[1] || "", index: 0, refs: [] };
    renderMention();
  }

  function insertMention(ref) {
    const sel = mentionState
      ? { start: mentionState.start, end: mentionState.end }
      : { start: promptEl.selectionStart ?? promptEl.value.length, end: promptEl.selectionEnd ?? promptEl.value.length };
    const ins = `${ref.label} `;
    promptEl.value = promptEl.value.slice(0, sel.start) + ins + promptEl.value.slice(sel.end);
    const caret = sel.start + ins.length;
    mentionState = null;
    renderMention();
    requestAnimationFrame(() => {
      promptEl.focus();
      promptEl.setSelectionRange(caret, caret);
      autoGrow();
      renderPromptCount();
    });
  }

  function mentionKeydown(e) {
    if (!mentionState || !mentionState.refs || !mentionState.refs.length) return false;
    if (e.key === "ArrowDown") { mentionState.index = (mentionState.index + 1) % mentionState.refs.length; renderMention(); return true; }
    if (e.key === "ArrowUp") { mentionState.index = (mentionState.index - 1 + mentionState.refs.length) % mentionState.refs.length; renderMention(); return true; }
    if (e.key === "Enter" || e.key === "Tab") { insertMention(mentionState.refs[mentionState.index]); return true; }
    if (e.key === "Escape") { mentionState = null; renderMention(); return true; }
    return false;
  }

  function autoGrow() {
    promptEl.style.height = "auto";
    promptEl.style.height = `${Math.min(Math.max(promptEl.scrollHeight, 116), 380)}px`;
  }
  function renderPromptCount() {
    const len = promptEl.value.length;
    $("#prompt-count").textContent = len ? `${len} 字` : "";
    renderBarPrompt();
  }

  /* 指挥条输入框：随内容自动长高，到上限后内部滚动 */
  function sizeBarInput() {
    const input = $("#bar-input");
    if (!input) return;
    if (!input.value) {
      input.style.height = "";
    } else {
      const max = window.matchMedia("(max-width: 920px)").matches ? 152 : 218;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    }
    if (barPanelOpen) positionBarPanel();
  }

  /* 指挥条素材缩略条：与生成器同一份素材 state，可单个移除 */
  function renderBarAttach() {
    const strip = $("#bar-attach-strip");
    if (!strip) return;
    strip.replaceChildren();
    let n = 0;

    /* 缩略图点击弹操作菜单：编辑标注 / 自动马赛克 / 移除 */
    const thumbPop = (anchor, title, hint, actions) => {
      openPop(anchor, (pop, close) => {
        pop.classList.add("attach-pop");
        pop.append(el("div", "pop-head", title));
        if (hint) pop.append(el("div", "pop-hint", hint));
        for (const a of actions) {
          if (a === "sep") { pop.append(el("div", "pop-sep")); continue; }
          const item = el("button", "pop-item", icon(a.ico, 14),
            el("div", "pi-main", el("div", "pi-title", a.title), a.sub ? el("div", "pi-sub", a.sub) : null));
          item.addEventListener("click", () => { close(); a.fn(); });
          pop.append(item);
        }
      }, { avoid: $(".cmdbar") });
    };

    state.urlImages.forEach((url, i) => {
      n += 1;
      const no = n;
      const t = el("div", "ba-item ba-thumb");
      const img = el("img");
      img.src = url;
      img.alt = `@图片${no}`;
      img.loading = "lazy";
      const remove = () => {
        state.urlImages = state.urlImages.filter((_, j) => j !== i);
        renderAssets(); renderQuote();
      };
      const x = el("button", "ba-x", icon("x", 10));
      x.title = "移除";
      x.addEventListener("click", (e) => { e.stopPropagation(); remove(); });
      t.title = `@图片${no} · ${url}`;
      t.append(img, x);
      t.addEventListener("click", (e) => {
        if (e.target.closest(".ba-x")) return;
        thumbPop(t, `@图片${no} · URL 引用`, url, [
          { ico: "trash", title: "移除", fn: remove }
        ]);
      });
      strip.append(t);
    });
    state.localImages.forEach((it) => {
      n += 1;
      const no = n;
      const t = el("div", `ba-item ba-thumb${it.error ? " is-err" : ""}`);
      const img = el("img");
      img.src = it.previewUrl;
      img.alt = it.name;
      const x = el("button", "ba-x", icon("x", 10));
      x.title = "移除";
      x.addEventListener("click", (e) => { e.stopPropagation(); removeLocalImage(it.id); });
      t.title = it.error ? `${it.name} · ${it.error}` : `@图片${no} · ${it.name}`;
      t.append(img, x);
      if (!it.error) {
        if (it.maskStatus === "detecting") t.append(el("span", "ba-state detecting", "检测中"));
        else if (it.maskStatus === "masked") t.append(el("span", "ba-state masked", "已打码"));
        else if (it.edited) t.append(el("span", "ba-state masked", "已标注"));
      }
      t.addEventListener("click", (e) => {
        if (e.target.closest(".ba-x")) return;
        const hint = it.error ? it.error
          : it.maskStatus === "detecting" ? "正在识别人脸，完成后可继续编辑…"
          : it.maskStatus === "masked" ? `已自动打码 ${it.faceCount || 0} 张人脸`
          : it.edited ? "已编辑标注" : "";
        const actions = [];
        if (!it.error && it.maskStatus !== "detecting") {
          actions.push(
            { ico: "edit", title: "编辑标注", sub: "画笔 / 形状 / 手动打码", fn: () => openEditor(it) },
            { ico: "face", title: "自动马赛克", sub: "本地识别人脸并打码", fn: () => autoMask(it) },
            "sep"
          );
        }
        actions.push({ ico: "trash", title: "移除", fn: () => removeLocalImage(it.id) });
        thumbPop(t, it.name || `@图片${no}`, hint, actions);
      });
      strip.append(t);
    });

    if (state.mode === "video") {
      let an = 0;
      state.urlAudios.forEach((a, i) => {
        an += 1; n += 1;
        const c = el("div", "ba-item ba-aud");
        const x = el("button", "ba-x", icon("x", 10));
        x.title = "移除";
        x.addEventListener("click", () => {
          state.urlAudios = state.urlAudios.filter((_, j) => j !== i);
          renderAssets(); renderQuote();
        });
        c.title = a.url;
        c.append(icon("link", 11), el("span", "ba-name", a.name || `@音频${an}`), x);
        strip.append(c);
      });
      state.localAudios.forEach((a) => {
        an += 1; n += 1;
        const c = el("div", `ba-item ba-aud${a.error ? " is-err" : ""}`);
        const x = el("button", "ba-x", icon("x", 10));
        x.title = "移除";
        x.addEventListener("click", () => removeLocalAudio(a.id));
        c.title = a.error ? `${a.name} · ${a.error}` : a.name;
        c.append(icon("music", 11), el("span", "ba-name", a.name), x);
        strip.append(c);
      });
    }

    strip.classList.toggle("hidden", n === 0);
    if (barPanelOpen) positionBarPanel();
  }

  /* 指挥条输入框：与生成器大输入框双向同步 */
  function renderBarPrompt() {
    const input = $("#bar-input");
    if (!input) return;
    input.placeholder = state.mode === "image"
      ? "描述你想生成的图片，回车生成，Shift+回车换行…"
      : "描述你想生成的视频，回车生成，Shift+回车换行…";
    if (document.activeElement !== input && input.value !== promptEl.value) {
      input.value = promptEl.value;
    }
    sizeBarInput();
  }

  /* 生成器开合：指挥条与左侧面板之间的 FLIP 形变；画廊同步让位不被遮挡 */
  let morphTimer = 0;
  let morphTimer2 = 0;
  let squeezeTimer = 0;
  function setComposer(open, opts = {}) {
    open = !!open;
    const win = $("#win-composer");
    const bar = $(".cmdbar");
    if (!win || !bar) return;
    if (state.composerOpen === open) return;
    state.composerOpen = open;
    clearTimeout(morphTimer);
    clearTimeout(morphTimer2);
    clearTimeout(squeezeTimer);

    const works = $(".works");
    /* 画廊让位与面板动画并行。开始时就把网格钉在让位后的最终宽度并按它排版：
       动画期间卡片尺寸完全不变，只随容器平移显隐；结束后解除钉宽再校准一次
       （列数没变会被 renderTasks 的签名检查跳过，不会重挂视频）。 */
    const squeeze = () => {
      const grid = $("#works-grid");
      const cur = grid ? grid.clientWidth : 0;
      document.body.classList.toggle("composer-open", open);
      if (cur && !window.matchMedia("(max-width: 920px)").matches) {
        const compW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--composer-w")) || 446;
        const target = Math.max(260, open ? cur - compW - 16 : cur + compW + 16);
        grid.style.width = `${target}px`;
        renderTasks(target);
      }
      squeezeTimer = setTimeout(() => {
        if (grid) grid.style.width = "";
        renderTasks();
      }, 540);
    };

    const focusPrompt = () => {
      promptEl.focus();
      autoGrow();
      positionMention();
    };

    if (opts.instant) {
      win.style.transition = "none";
      if (works) works.style.transition = "none";
      document.body.classList.toggle("composer-open", open);
      win.style.transform = "";
      win.classList.toggle("show", open);
      win.classList.remove("morphing", "closing");
      bar.classList.toggle("gone", open);
      void win.offsetHeight;
      win.style.transition = "";
      if (works) works.style.transition = "";
      renderTasks();
      if (open) requestAnimationFrame(focusPrompt);
      else { mentionState = null; renderMention(); }
      return;
    }

    if (open) {
      squeeze();
      /* 量好指挥条矩形 → 面板先变成“指挥条的样子” → 再展开归位 */
      const br = bar.getBoundingClientRect();
      bar.classList.add("gone");
      win.classList.add("show", "morphing");
      win.classList.remove("closing");
      win.style.transition = "none";
      win.style.transform = "";
      const wr = win.getBoundingClientRect();
      win.style.transform =
        `translate(${br.left - wr.left}px, ${br.top - wr.top}px) ` +
        `scale(${br.width / wr.width}, ${br.height / wr.height})`;
      void win.offsetHeight;
      win.style.transition = "";
      win.style.transform = "";
      win.classList.remove("morphing");
      morphTimer = setTimeout(focusPrompt, 360);
    } else {
      squeeze();
      mentionState = null;
      renderMention();
      /* 目标矩形：临时无动画地“显形”指挥条量一次 */
      bar.style.transition = "none";
      bar.classList.remove("gone");
      const br = bar.getBoundingClientRect();
      bar.classList.add("gone");
      void bar.offsetHeight;
      bar.style.transition = "";

      const wr = win.getBoundingClientRect();
      win.classList.add("morphing", "closing");
      win.style.transform =
        `translate(${br.left - wr.left}px, ${br.top - wr.top}px) ` +
        `scale(${br.width / wr.width}, ${br.height / wr.height})`;
      /* 指挥条提前淡入，与面板末段淡出交叉融合，避免硬切 */
      morphTimer2 = setTimeout(() => bar.classList.remove("gone"), 240);
      morphTimer = setTimeout(() => {
        win.classList.remove("show", "morphing", "closing");
        win.style.transition = "none";
        win.style.transform = "";
        void win.offsetHeight;
        win.style.transition = "";
      }, 500);
    }
  }

  /* ==================== O. 上传与提交 ==================== */

  function rememberAsset(ref) {
    if (!ref || !ref.id) return;
    state.recentAssets = [...state.recentAssets.filter(x => x.id !== ref.id), ref].slice(-80);
  }

  /* 把本地素材上传，返回最终 URL 列表（含已有 URL 引用） */
  async function uploadPending(includeAudio) {
    let images = [...state.urlImages];
    let audios = includeAudio ? [...state.urlAudios] : [];
    const assetRefs = [];
    const localImgs = state.localImages.filter(x => !x.error);
    const localAuds = includeAudio ? state.localAudios.filter(x => !x.error) : [];
    if (!localImgs.length && !localAuds.length) return { images, audios, assetRefs };

    state.uploading = true;
    setGoState();
    try {
      if (localImgs.length) {
        setGoState(`正在上传参考图片 ${localImgs.length} 张…`);
        const res = await api.uploadImages(localImgs.map(x => x.file), { licenseKey: state.licenseKey, fingerprint: state.fingerprint });
        const files = (res.files || []).filter(f => !!f.url);
        if (files.length !== localImgs.length) throw new Error("图床返回的图片数量不完整");
        for (const f of files) {
          if (f.assetId) {
            const ref = { id: f.assetId, kind: "image", url: f.url };
            assetRefs.push(ref);
            rememberAsset(ref);
          }
          images.push(f.url);
        }
        state.urlImages = images;
        for (const it of state.localImages) URL.revokeObjectURL(it.previewUrl);
        state.localImages = [];
      }
      if (localAuds.length) {
        setGoState(`正在上传参考音频 ${localAuds.length} 段…`);
        const res = await api.uploadAudios(localAuds.map(x => x.file), { licenseKey: state.licenseKey, fingerprint: state.fingerprint });
        const files = (res.files || []).map((f, i) => ({
          url: f.url,
          name: f.name || localAuds[i] && localAuds[i].name,
          duration: f.duration || (localAuds[i] && localAuds[i].duration),
          assetId: f.assetId
        })).filter(f => !!f.url);
        if (files.length !== localAuds.length) throw new Error("图床返回的音频数量不完整");
        for (const f of files) {
          if (f.assetId) {
            const ref = { id: f.assetId, kind: "audio", url: f.url };
            assetRefs.push(ref);
            rememberAsset(ref);
          }
          audios.push(f);
        }
        state.urlAudios = audios;
        for (const it of state.localAudios) URL.revokeObjectURL(it.previewUrl);
        state.localAudios = [];
      }
      if (assetRefs.length) refreshLibrary({ silent: true });
      renderAssets();
      return { images, audios, assetRefs };
    } finally {
      state.uploading = false;
      setGoState();
    }
  }

  /* 汇总 assetIds：上传得到的 + 近期引用映射到 URL 的 */
  function collectAssetIds(images, audios, freshRefs) {
    const used = new Set([...images, ...audios.map(a => a.url)].filter(Boolean));
    const ids = new Set();
    for (const a of audios) if (a.assetId) ids.add(a.assetId);
    for (const ref of [...state.recentAssets, ...freshRefs]) {
      if (ref.id && used.has(ref.url)) ids.add(ref.id);
    }
    for (const a of state.assets) {
      if (a && a.id && used.has(a.url)) ids.add(a.id);
    }
    return [...ids];
  }

  function setGoState(text) {
    const barGo = $("#bar-go");
    if (barGo) barGo.classList.toggle("working", state.submitting);
    const go = $("#btn-go");
    const label = $("#go-text");
    if (state.submitting) {
      go.classList.add("working");
      label.textContent = text || (state.uploading ? "上传中…" : "提交中…");
    } else {
      go.classList.remove("working");
      label.textContent = state.mode === "image" ? "生成图片" : "开始生成";
    }
  }

  async function submit() {
    if (state.submitting || state.view !== "studio") return;
    const prompt = promptEl.value.trim();
    try {
      if (!state.licenseKey) throw new Error("请先完成访问验证");
      if (!prompt) throw new Error(state.mode === "image" ? "请输入图片提示词" : "请输入视频文案");
      const q = activeQuote();
      if (!q) throw new Error(state.mode === "image" ? "当前图片档位暂不可用" : "当前模型暂不可用");
      if (!hasEnoughPoints()) throw new Error(`${balanceInfo().label}不足，请联系管理员处理`);
      if (state.mode === "video" && isFLF() && imageCount() < 1) throw new Error("首尾帧模式至少需要 1 张图片");
      const problems = collectProblems();
      if (problems.length) throw new Error(problems[0]);
    } catch (e) {
      toast(errMsg(e), "err");
      return;
    }

    state.submitting = true;
    setGoState();
    renderQuote();
    try {
      if (state.mode === "image") {
        const { images, assetRefs } = await uploadPending(false);
        const assetIds = collectAssetIds(images, [], assetRefs);
        const res = await api.imageGenerate({
          licenseKey: state.licenseKey,
          fingerprint: state.fingerprint,
          prompt,
          model: state.imageModel,
          aspectRatio: state.imageRatio,
          images,
          assetIds,
          displayName: displayName()
        });
        if (res.charge || res.balance) { state.balance = res.charge || res.balance; renderPoints(); }
        pushTask({
          kind: "image",
          taskCode: res.task.taskCode,
          status: res.task.status,
          prompt,
          model: state.imageModel,
          duration: "image",
          aspectRatio: state.imageRatio,
          quote: res.quote,
          progress: 0,
          progressText: "已提交",
          createdAt: new Date().toISOString(),
          charged: !!res.charge,
          charge: res.charge,
          holdId: res.hold && res.hold.points && res.hold.points.hold ? res.hold.points.hold.id : null,
          holdStatus: res.hold && res.hold.points && res.hold.points.hold ? res.hold.points.hold.status : null,
          hold: res.hold,
          images,
          audios: [],
          assetIds,
          imageTier: (res.quote && res.quote.tier) || undefined,
          imageSize: res.quote && res.quote.size
        });
        const kindText = images.length ? "图生图" : "文生图";
        toast(res.chargeStage === "hold"
          ? `${kindText}任务已提交，已预扣积分，成功后确认扣费，失败会自动释放`
          : res.chargeStage === "submit" ? `${kindText}任务已提交，正在生成` : `${kindText}任务已提交，生成成功后可查看`, "ok");
        setComposer(false);
      } else {
        const { images, audios, assetRefs } = await uploadPending(!isFLF());
        const useAudios = isFLF() ? [] : audios;
        const assetIds = collectAssetIds(images, useAudios, assetRefs);
        const res = await api.generate({
          licenseKey: state.licenseKey,
          fingerprint: state.fingerprint,
          prompt,
          model: state.videoModel,
          duration: state.duration,
          aspectRatio: state.videoRatio,
          images,
          audios: useAudios,
          assetIds,
          referenceMode: state.refMode,
          displayName: displayName()
        });
        if (res.charge || res.balance) { state.balance = res.charge || res.balance; renderPoints(); }
        pushTask({
          taskCode: res.task.taskCode,
          status: res.task.status,
          prompt,
          model: state.videoModel,
          duration: state.duration,
          aspectRatio: state.videoRatio,
          quote: res.quote,
          progress: 0,
          progressText: "已提交",
          createdAt: new Date().toISOString(),
          charged: !!res.charge,
          charge: res.charge,
          holdId: res.hold && res.hold.points && res.hold.points.hold ? res.hold.points.hold.id : null,
          holdStatus: res.hold && res.hold.points && res.hold.points.hold ? res.hold.points.hold.status : null,
          hold: res.hold,
          images,
          audios: useAudios,
          assetIds,
          referenceMode: state.refMode
        });
        toast(res.chargeStage === "hold"
          ? "任务已提交，已预扣积分，成功后确认扣费，失败会自动释放"
          : res.chargeStage === "submit" ? "任务已提交，正在为你生成视频" : "任务已提交，生成成功后可直接预览", "ok");
        setComposer(false);
      }
    } catch (e) {
      toast(errMsg(e), "err", 5200);
    } finally {
      state.submitting = false;
      setGoState();
      renderQuote();
    }
  }

  /* ==================== P. 任务存储 ==================== */

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(t => t && typeof t === "object" && t.taskCode).slice(0, TASK_CAP);
  }
  function saveTasks() {
    if (!state.licenseKey) return;
    try {
      localStorage.setItem(taskStoreKey(state.licenseKey), JSON.stringify(state.tasks.slice(0, TASK_CAP)));
    } catch { /* 存储满时静默 */ }
  }
  function pushTask(t) {
    state.tasks = [t, ...state.tasks].slice(0, TASK_CAP);
    saveTasks();
    renderTasks();
  }
  function isImageTask(t) {
    if (t.kind === "image") return true;
    return (t.files || []).some(f =>
      String(f.fileType || "").includes("image") || String(f.mimeType || "").startsWith("image/"));
  }
  function isActiveTask(t) { return !["completed", "failed"].includes(t.status); }

  /* ==================== Q. 任务轮询 ==================== */

  let pollTimer = 0;
  let pollBusy = false;

  function startPolling() {
    stopPolling();
    pollOnce();
    pollTimer = window.setInterval(pollOnce, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  }

  async function pollOnce() {
    if (pollBusy || state.view !== "studio" || !state.licenseKey) return;
    const active = state.tasks.filter(isActiveTask);
    if (!active.length) return;
    pollBusy = true;
    try {
      const results = await Promise.allSettled(active.map(t =>
        (t.kind === "image" ? api.imageTask : api.videoTask)({
          taskCode: t.taskCode,
          licenseKey: state.licenseKey,
          fingerprint: state.fingerprint,
          model: t.model,
          duration: t.duration,
          aspectRatio: t.aspectRatio,
          holdId: t.holdId || undefined
        })
      ));
      const patch = new Map();
      results.forEach((r, i) => {
        const local = active[i];
        if (r.status === "fulfilled") {
          const v = r.value;
          const remote = v.task || {};
          patch.set(local.taskCode, {
            ...local,
            ...remote,
            model: local.model,
            duration: local.duration,
            aspectRatio: local.aspectRatio,
            kind: local.kind,
            imageTier: local.imageTier,
            imageSize: local.imageSize,
            quote: v.quote || local.quote,
            createdAt: local.createdAt,
            charged: local.charged || !!v.charge,
            charge: v.charge || local.charge,
            holdId: (v.hold && v.hold.points && v.hold.points.hold && v.hold.points.hold.id) || local.holdId,
            holdStatus: (v.hold && v.hold.points && v.hold.points.hold && v.hold.points.hold.status) || local.holdStatus,
            hold: v.hold || local.hold
          });
          if (v.balance) { state.balance = v.balance; renderPoints(); }
          if (v.charge && v.charge.points) {
            toast(local.kind === "image" ? "图片已完成，可直接查看和下载" : "视频已完成，可直接预览", "ok");
          } else if (v.hold && v.hold.points && v.hold.points.hold && v.hold.points.hold.status === "released") {
            toast("任务失败，已释放预扣积分", "err");
          }
        } else {
          const msg = errMsg(r.reason).trim();
          if (msg === "task_not_found") {
            patch.set(local.taskCode, {
              ...local,
              status: "failed",
              progress: 100,
              progressText: "生成失败",
              errorMsg: "任务不存在或已过期，请重新提交生成",
              holdStatus: local.holdStatus === "holding" ? "released" : local.holdStatus
            });
            toast("任务不存在或已过期，已停止轮询", "err");
          }
          /* 网络错误等临时失败：跳过本轮，下轮继续 */
        }
      });
      if (patch.size) {
        state.tasks = state.tasks.map(t => patch.get(t.taskCode) || t);
        saveTasks();
        renderTasks();
      }
    } finally {
      pollBusy = false;
    }
  }

  /* ==================== R. 任务卡渲染 ==================== */

  const cardCache = new Map(); // taskCode -> {sig, node}

  function taskSig(t) {
    return [t.status, t.progress, t.progressText, (t.files || []).length, t.holdStatus, t.charged, t.errorMsg].join("|");
  }

  function ratioPadding(ratio) {
    const m = String(ratio || "16:9").split(":").map(Number);
    if (m.length === 2 && m[0] > 0 && m[1] > 0) return `${(m[1] / m[0]) * 100}%`;
    return "56.25%";
  }

  function videoFiles(t) {
    const files = t.files || [];
    const sd = files.find(f => f.fileType === "video_sd");
    const hd = files.find(f => f.fileType === "video_hd");
    const any = files.find(f => String(f.mimeType || "").startsWith("video/"));
    return { sd, hd, any };
  }
  function imageFiles(t) {
    return (t.files || []).filter(f =>
      String(f.fileType || "").includes("image") || String(f.mimeType || "").startsWith("image/"));
  }

  function statusToken(t) {
    if (t.status === "completed") return { text: "已完成", cls: "tag-green" };
    if (t.status === "failed") return { text: "失败", cls: "tag-red" };
    if (t.status === "generating") return { text: t.progressText || "生成中", cls: "tag-accent" };
    return { text: t.progressText || "等待中", cls: "tag-dim" };
  }

  function triggerDownload(url, filename) {
    const a = document.createElement("a");
    a.href = bestDownloadUrl(url, filename);
    a.download = filename;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }

  function reuseTask(t) {
    const toImage = isImageTask(t);
    state.mode = toImage ? "image" : "video";
    promptEl.value = t.prompt || "";
    if (toImage) {
      if (t.model && tierOptions().includes(t.model)) state.imageModel = t.model;
      if (t.aspectRatio) state.imageRatio = t.aspectRatio;
      state.urlImages = [...(t.images || [])];
      state.urlAudios = [];
    } else {
      if (t.model && modelOptions().includes(t.model)) state.videoModel = t.model;
      if (t.duration && durationOptions().includes(t.duration)) state.duration = t.duration;
      if (t.aspectRatio) state.videoRatio = t.aspectRatio;
      state.refMode = t.referenceMode || "multimodal";
      state.urlImages = [...(t.images || [])];
      state.urlAudios = isFLF() ? [] : (t.audios || []).map(a => typeof a === "string" ? { url: a } : { ...a });
    }
    renderMode();
    autoGrow();
    renderPromptCount();
    setComposer(true);
    $("#composer-scroll").scrollTo({ top: 0, behavior: "smooth" });
    toast(toImage ? "已复用图片任务提示词、参数和参考图" : "已复用任务内容，图片、音频和提示词已填入当前输入框", "ok");
  }

  async function registerToLibrary(t, f) {
    if (!state.licenseKey) return;
    if (!f.sha256) { toast("这张图片缺少素材指纹，暂不能加入素材库", "err"); return; }
    try {
      const res = await api.assetsRegister({
        licenseKey: state.licenseKey,
        fingerprint: state.fingerprint,
        url: f.fileUrl,
        sha256: f.sha256,
        name: f.name || `${t.taskCode}.${f.format || "png"}`,
        mimeType: f.mimeType || "image/png",
        size: f.size,
        width: f.width,
        height: f.height
      });
      const asset = res.asset;
      if (asset) {
        state.assets = [asset, ...state.assets.filter(a => a.id !== asset.id)].slice(0, 100);
        rememberAsset({ id: asset.id, kind: asset.kind || "image", url: asset.url });
        renderLibrary();
        toast(asset.reused ? "素材库已有这张图片，已为你复用" : "已加入素材库，后续视频任务可直接使用", "ok");
      }
      refreshLibrary({ silent: true });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  function continueI2I(url) {
    state.mode = "image";
    if (!state.urlImages.includes(url)) {
      if (state.urlImages.length + state.localImages.length >= 9) {
        toast("图片生成参考图最多支持 9 张", "err");
        return;
      }
      state.urlImages = [...state.urlImages, url];
    }
    renderMode();
    setComposer(true);
    toast("已把这张生成图加入图片生成参考图，可继续图生图", "ok");
    $("#composer-scroll").scrollTo({ top: 0, behavior: "smooth" });
  }

  function openLightbox(url, isVideo) {
    const box = el("div", "lightbox");
    let media;
    if (isVideo) {
      media = el("video");
      media.src = url;
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
    } else {
      media = el("img");
      media.src = url;
    }
    media.addEventListener("click", (e) => e.stopPropagation());
    const x = el("button", "lb-x", icon("x"));
    box.append(media, x);
    document.body.append(box);
    const close = () => { if (isVideo) { try { media.pause(); } catch {} } box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    x.addEventListener("click", close);
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
  }

  function smallBtn(label, iconName, onClick, extraCls) {
    const b = el("button", `btn btn-sm${extraCls ? " " + extraCls : ""}`, iconName ? icon(iconName) : null, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function buildCard(t) {
    const card = el("article", "card");
    card.dataset.code = t.taskCode;

    /* —— 媒体区 —— */
    const media = el("div", "card-media");
    const box = el("div", "cm-box");
    box.style.paddingTop = isImageTask(t) && (t.files || []).length > 1 ? "100%" : ratioPadding(t.aspectRatio);
    media.append(box);

    if (t.status === "completed") {
      if (isImageTask(t)) {
        const imgs = imageFiles(t);
        if (imgs.length <= 1) {
          const f = imgs[0];
          if (f) {
            const img = el("img");
            img.src = f.fileUrl;
            img.loading = "lazy";
            img.alt = t.prompt || "";
            img.addEventListener("click", () => openLightbox(f.fileUrl, false));
            box.append(img);
          }
        } else {
          const grid = el("div", "card-imgs");
          grid.style.gridTemplateColumns = `repeat(${imgs.length === 2 ? 2 : 2}, 1fr)`;
          for (const f of imgs.slice(0, 4)) {
            const img = el("img");
            img.src = f.fileUrl;
            img.loading = "lazy";
            img.addEventListener("click", () => openLightbox(f.fileUrl, false));
            grid.append(img);
          }
          box.append(grid);
        }
      } else {
        const { sd, hd, any } = videoFiles(t);
        const src = (sd || hd || any || {}).fileUrl;
        if (src) {
          const video = el("video");
          video.src = src;
          video.controls = true;
          video.preload = "metadata";
          video.playsInline = true;
          box.append(video);
        }
      }
    } else if (t.status === "failed") {
      const fail = el("div", "card-failed",
        icon("alert"),
        el("div", "cf-title", "生成失败"),
        el("div", "cf-msg", t.errorMsg || t.progressText || "生成失败")
      );
      box.append(fail);
    } else {
      const hasPct = Number.isFinite(Number(t.progress)) && Number(t.progress) > 0;
      const pct = hasPct ? Math.min(99, Math.round(Number(t.progress))) : null;
      const corners = el("div", "cp-corners", el("i"), el("i"), el("i"), el("i"));
      const track = el("div", `cp-track${hasPct ? "" : " indet"}`);
      const bar = el("i");
      if (hasPct) bar.style.width = `${pct}%`;
      track.append(bar);
      const prog = el("div", "card-progress",
        corners,
        el("div", "cp-pct", hasPct ? `${pct}%` : "··"),
        el("div", "cp-text", t.progressText || (t.status === "generating" ? "生成中" : "等待中")),
        track
      );
      box.append(prog);
    }

    card.append(media);

    /* —— 内容区 —— */
    const body = el("div", "card-body");

    const promptLine = el("div", "card-prompt", t.prompt || "（无提示词）");
    promptLine.title = "点击展开 / 收起";
    promptLine.addEventListener("click", () => promptLine.classList.toggle("open"));
    body.append(promptLine);

    /* meta */
    const st = statusToken(t);
    const meta = el("div", "card-meta");
    meta.append(el("span", `tag ${st.cls}`, st.text));
    meta.append(el("span", null, isImageTask(t) ? "图片" : "视频"));
    meta.append(el("span", null, t.model || ""));
    if (!isImageTask(t) && t.duration) meta.append(el("span", null, t.duration));
    if (t.aspectRatio) meta.append(el("span", null, t.aspectRatio));
    const qp = t.quote && Number.isFinite(Number(t.quote.totalPoints)) ? fmtPoints(t.quote.totalPoints) : null;
    if (qp != null) {
      if (t.charged || (t.charge && t.charge.points)) meta.append(el("span", "cm-status-ok", `已扣 ${qp}`));
      else if (t.holdStatus === "released") meta.append(el("span", "cm-status-released", "已释放预扣"));
      else if (t.holdStatus) meta.append(el("span", "cm-status-hold", `预扣 ${qp}`));
      else meta.append(el("span", "cm-pts", `预计 ${qp}`));
    }
    if (t.createdAt) meta.append(el("span", null, fmtTime(t.createdAt)));
    body.append(meta);

    /* 操作 */
    const acts = el("div", "card-acts");
    if (t.status === "completed") {
      if (isImageTask(t)) {
        const imgs = imageFiles(t);
        imgs.forEach((f, i) => {
          const suffix = imgs.length > 1 ? ` ${i + 1}` : "";
          acts.append(smallBtn(`下载图片${suffix}`, "download", () =>
            triggerDownload(f.fileUrl, f.name || `${t.taskCode}${suffix ? "-" + (i + 1) : ""}.${f.format || "png"}`), "btn-soft"));
        });
        const first = imgs[0];
        if (first) {
          acts.append(smallBtn("打开", "open", () => window.open(first.fileUrl, "_blank", "noopener")));
          acts.append(smallBtn("加入素材库", "box", () => registerToLibrary(t, first)));
          acts.append(smallBtn("继续图生图", "image", () => continueI2I(first.fileUrl)));
        }
      } else {
        const { sd, hd } = videoFiles(t);
        if (hd) acts.append(smallBtn("下载无水印", "download", () => {
          toast("无水印视频链接时效较短，请尽快下载", "info");
          triggerDownload(hd.fileUrl, `${t.taskCode}-hd.mp4`);
        }, "btn-soft"));
        if (sd) acts.append(smallBtn(hd ? "下载预览版" : "下载", "download", () =>
          triggerDownload(sd.fileUrl, `${t.taskCode}.mp4`)));
        const open = (hd || sd);
        if (open) acts.append(smallBtn("打开", "open", () => window.open(open.fileUrl, "_blank", "noopener")));
      }
    }
    acts.append(smallBtn("复用", "copy", () => reuseTask(t)));
    if (!isActiveTask(t)) {
      acts.append(smallBtn("移除", "trash", () => {
        state.tasks = state.tasks.filter(x => x.taskCode !== t.taskCode);
        cardCache.delete(t.taskCode);
        saveTasks();
        renderTasks();
      }, "btn-ghost"));
    }
    body.append(acts);
    card.append(body);
    return card;
  }

  let worksGridSig = "";
  function renderTasks(targetWidth) {
    if (state.view !== "studio") return;
    const grid = $("#works-grid");
    /* 视频与图片作品混排在同一条瀑布流里 */
    const list = state.tasks;

    $("#works-empty").classList.toggle("hidden", list.length > 0);
    $("#btn-clear-tasks").classList.toggle("hidden", state.tasks.length === 0);

    const items = [];
    const liveCodes = new Set();
    const sigParts = [];
    for (const t of list) {
      liveCodes.add(t.taskCode);
      const sig = taskSig(t);
      sigParts.push(`${t.taskCode}:${sig}`);
      const cached = cardCache.get(t.taskCode);
      if (cached && cached.sig === sig) {
        items.push({ node: cached.node, est: estimateCardH(t) });
      } else {
        const node = buildCard(t);
        cardCache.set(t.taskCode, { sig, node });
        items.push({ node, est: estimateCardH(t) });
      }
    }
    for (const code of [...cardCache.keys()]) {
      if (!liveCodes.has(code) && !state.tasks.some(t => t.taskCode === code)) cardCache.delete(code);
    }

    /* 瀑布流：按预估高度把卡片分发到最矮的列 */
    const width = targetWidth || grid.clientWidth || grid.parentElement.clientWidth || 1200;
    const cols = Math.max(1, Math.min(6, Math.floor(width / 272)));
    /* 列数与卡片都没变：跳过重排，避免视频元素被重新挂载产生闪烁 */
    const sigKey = `${cols}|${sigParts.join(",")}`;
    if (sigKey === worksGridSig && grid.children.length) return;
    worksGridSig = sigKey;
    const colEls = Array.from({ length: cols }, () => el("div", "wf-col"));
    const heights = new Array(cols).fill(0);
    for (const { node, est } of items) {
      let k = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[k]) k = i;
      colEls[k].append(node);
      heights[k] += est;
    }
    grid.replaceChildren(...colEls);
  }

  /* 以宽高比估算卡片相对高度（同宽列内只需相对一致） */
  function estimateCardH(t) {
    let ratio = 9 / 16;
    const m = String(t.aspectRatio || "16:9").split(":").map(Number);
    if (m.length === 2 && m[0] > 0 && m[1] > 0) ratio = m[1] / m[0];
    if (isImageTask(t) && (t.files || []).length > 1) ratio = 1;
    return ratio * 320 + 150;
  }

  async function clearTasks() {
    const running = state.tasks.filter(isActiveTask).length;
    const ok = await confirmBox({
      title: "清空任务记录",
      message: running
        ? `还有 ${running} 个任务正在生成，清空后将停止跟踪它们（不影响服务器端执行与扣费）。确定清空全部记录吗？`
        : "任务记录仅保存在本机浏览器中，清空后无法恢复。确定清空吗？",
      okText: "清空",
      danger: true
    });
    if (!ok) return;
    state.tasks = [];
    cardCache.clear();
    saveTasks();
    renderTasks();
  }

  /* ==================== S. 素材库 ==================== */

  async function refreshLibrary({ silent = false } = {}) {
    if (!state.licenseKey || state.view !== "studio") return;
    state.libraryLoading = true;
    renderLibrary();
    try {
      const res = await api.assetsList(state.licenseKey, state.fingerprint, 40);
      state.assets = res.assets || [];
    } catch (e) {
      if (!silent) toast(errMsg(e), "err");
    } finally {
      state.libraryLoading = false;
      renderLibrary();
    }
  }

  function assetInUse(a) {
    if (a.kind === "audio") return state.urlAudios.some(x => x.url === a.url);
    return state.urlImages.includes(a.url);
  }

  function useAsset(a) {
    if (a.kind === "audio") {
      if (!audioAllowed()) {
        toast(state.mode === "image" ? "图片生成暂不支持音频素材" : "首尾帧模式不支持音频；如需音频请切换到多模态参考", "err");
        return;
      }
      if (state.urlAudios.some(x => x.url === a.url)) { toast("该音频已在引用列表中", "info", 1800); return; }
      if (audioCount() >= MAX_AUDIOS) { toast(`音频最多支持 ${MAX_AUDIOS} 段`, "err"); return; }
      state.urlAudios = [...state.urlAudios, { url: a.url, name: a.name || undefined, duration: a.duration || undefined, assetId: a.id }];
      toast("已加入参考音频，可在提示词里输入 @音频 选择引用", "ok");
    } else {
      if (state.urlImages.includes(a.url)) { toast("这张图已在引用列表中", "info", 1800); return; }
      if (imageCount() >= maxImages()) { toast(`${refModeText()}模式参考图最多支持 ${maxImages()} 张`, "err"); return; }
      state.urlImages = [...state.urlImages, a.url];
      toast("已加入参考图，可在提示词里输入 @图片 选择引用", "ok");
    }
    rememberAsset({ id: a.id, kind: a.kind, url: a.url });
    renderAssets();
    renderLibrary();
  }

  async function deleteAsset(a) {
    const ok = await confirmBox({
      title: "删除素材",
      message: "确认从素材库删除这个素材？历史任务不受影响。",
      okText: "删除",
      danger: true
    });
    if (!ok) return;
    try {
      await api.assetsDelete(state.licenseKey, state.fingerprint, a.id);
      state.assets = state.assets.filter(x => x.id !== a.id);
      state.recentAssets = state.recentAssets.filter(x => x.id !== a.id);
      renderLibrary();
      toast("素材已从素材库删除，历史任务不受影响", "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  function renderLibrary() {
    if (state.view !== "studio") return;
    const grid = $("#lib-grid");
    const empty = $("#lib-empty");
    $("#lib-count").textContent = state.libraryLoading ? "刷新中…" : (state.assets.length ? `${state.assets.length}` : "");
    grid.replaceChildren();
    const list = state.assets;
    empty.classList.toggle("hidden", !!list.length || state.libraryLoading);
    for (const a of list) {
      const item = el("div", `lib-item${assetInUse(a) ? " used" : ""}`);
      item.title = a.name || a.url;
      if (a.kind === "audio") {
        item.append(el("div", "li-audio", icon("music", 18)));
      } else {
        const img = el("img");
        img.src = a.url;
        img.loading = "lazy";
        item.append(img);
      }
      item.append(el("span", "li-kind", a.kind === "audio" ? "AUDIO" : "IMG"));
      const x = el("button", "li-x", icon("x", 10));
      x.title = "从素材库删除";
      x.addEventListener("click", (e) => { e.stopPropagation(); deleteAsset(a); });
      item.append(x);
      item.addEventListener("click", () => useAsset(a));
      grid.append(item);
    }
  }

  /* ==================== T. 图片编辑器 ==================== */

  const EDITOR_TOOLS = [
    { id: "mosaic", label: "马赛克", icon: "grid", area: true },
    { id: "blur", label: "模糊", icon: "droplet", area: true },
    { id: "brush", label: "画笔", icon: "brush", area: false },
    { id: "arrow", label: "箭头", icon: "arrow", area: false },
    { id: "rect", label: "矩形", icon: "rect", area: false },
    { id: "circle", label: "圆圈", icon: "circle", area: false },
    { id: "block", label: "遮挡", icon: "block", area: false }
  ];
  const EDITOR_COLORS = ["#ff3b30", "#ff9500", "#28a745", "#007aff", "#1d1d1f", "#ffffff"];
  const UNDO_MAX = 10;
  const UNDO_PIXEL_LIMIT = 12e6;

  function pixelateRegion(ctx, x, y, w, h, cell) {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.min(ctx.canvas.width - sx, Math.round(w));
    const sh = Math.min(ctx.canvas.height - sy, Math.round(h));
    if (sw < 2 || sh < 2) return;
    const dw = Math.max(1, Math.ceil(sw / Math.max(4, cell)));
    const dh = Math.max(1, Math.ceil(sh / Math.max(4, cell)));
    const tmp = document.createElement("canvas");
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, dw, dh, sx, sy, sw, sh);
    ctx.restore();
  }

  function blurRegion(ctx, x, y, w, h, radius) {
    const sx = Math.max(0, Math.round(x));
    const sy = Math.max(0, Math.round(y));
    const sw = Math.min(ctx.canvas.width - sx, Math.round(w));
    const sh = Math.min(ctx.canvas.height - sy, Math.round(h));
    if (sw < 2 || sh < 2) return;
    const tmp = document.createElement("canvas");
    tmp.width = sw; tmp.height = sh;
    const tctx = tmp.getContext("2d");
    tctx.filter = `blur(${Math.max(2, radius)}px)`;
    tctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.drawImage(tmp, sx, sy);
  }

  function ellipseMosaic(ctx, box, cell) {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(ctx.canvas.width - x, Math.round(box.width));
    const h = Math.min(ctx.canvas.height - y, Math.round(box.height));
    if (w < 2 || h < 2) return;
    const dw = Math.max(1, Math.ceil(w / Math.max(4, cell)));
    const dh = Math.max(1, Math.ceil(h / Math.max(4, cell)));
    const tmp = document.createElement("canvas");
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, dw, dh);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, dw, dh, x, y, w, h);
    ctx.restore();
  }

  function canvasToFile(canvas, origName, suffix) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("图片导出失败")); return; }
        const base = String(origName || "image").replace(/\.[^.]+$/, "");
        resolve(new File([blob], `${base}.${suffix}.png`, { type: "image/png" }));
      }, "image/png");
    });
  }

  function replaceLocalImageFile(item, file, patch) {
    const idx = state.localImages.findIndex(x => x.id === item.id);
    if (idx < 0) return false;
    URL.revokeObjectURL(state.localImages[idx].previewUrl);
    const previewUrl = URL.createObjectURL(file);
    state.localImages[idx] = { ...state.localImages[idx], file, previewUrl, size: file.size, name: file.name, ...patch };
    renderAssets();
    return true;
  }

  function openEditor(item) {
    if (state.submitting) return;
    const wrap = el("div", "editor-wrap");
    const editor = el("div", "editor");
    wrap.append(editor);

    let tool = "mosaic";
    let color = EDITOR_COLORS[0];
    let areaSize = 96;
    let strokeSize = 12;
    let undoStack = [];
    let undoDisabled = false;
    let drawing = false;
    let startPt = null;
    let lastPt = null;
    let shapeSnapshot = null;
    let imgLoaded = false;
    let saving = false;

    const canvas = el("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const stage = el("div", "editor-stage");
    const stageMsg = el("div", "es-msg", "正在载入图片…");
    stage.append(canvas, stageMsg);

    const statusBar = el("span", "ef-status");
    const setStatus = (text, isErr) => {
      statusBar.textContent = text || "";
      statusBar.classList.toggle("err", !!isErr);
    };

    const isAreaTool = () => !!EDITOR_TOOLS.find(t => t.id === tool && t.area);
    const curSize = () => isAreaTool() ? areaSize : strokeSize;

    /* —— 侧栏 —— */
    const side = el("div", "editor-side");

    const toolGrid = el("div", "tool-grid");
    const toolBtns = new Map();
    for (const t of EDITOR_TOOLS) {
      const b = el("button", `tool-btn${t.id === tool ? " on" : ""}`, icon(t.icon), t.label);
      b.type = "button";
      b.addEventListener("click", () => {
        tool = t.id;
        for (const [id, btn] of toolBtns) btn.classList.toggle("on", id === tool);
        syncSlider();
        setStatus(t.area ? "在图片上拖动即可打码。" : (t.id === "brush" ? "按住拖动画线，可圈出重点区域。" : "从起点拖到终点即可添加标注或遮挡。"));
      });
      toolBtns.set(t.id, b);
      toolGrid.append(b);
    }

    const swatches = el("div", "swatches");
    const swatchBtns = [];
    for (const c of EDITOR_COLORS) {
      const s = el("button", `swatch${c === color ? " on" : ""}`);
      s.type = "button";
      s.style.background = c;
      s.title = `选择颜色 ${c}`;
      s.addEventListener("click", () => {
        color = c;
        swatchBtns.forEach(x => x.classList.toggle("on", x === s));
      });
      swatchBtns.push(s);
      swatches.append(s);
    }

    const slider = el("input");
    slider.type = "range";
    const sliderVal = el("span", "sv");
    const sliderLabel = el("span", "es-label");
    const colorBlk = el("div", "es-blk", el("span", "es-label", "标注颜色"), swatches);
    function syncSlider() {
      colorBlk.classList.toggle("hidden", isAreaTool());
      if (isAreaTool()) {
        sliderLabel.textContent = "处理范围";
        slider.min = "24"; slider.max = "200"; slider.value = String(areaSize);
      } else {
        sliderLabel.textContent = "线条粗细";
        slider.min = "2"; slider.max = "40"; slider.value = String(strokeSize);
      }
      sliderVal.textContent = `${slider.value}px`;
    }
    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      if (isAreaTool()) areaSize = v; else strokeSize = v;
      sliderVal.textContent = `${slider.value}px`;
    });

    const undoBtn = el("button", "btn btn-sm", icon("undo"), "撤销");
    undoBtn.type = "button";
    undoBtn.disabled = true;
    undoBtn.addEventListener("click", () => {
      const snap = undoStack.pop();
      if (snap) ctx.putImageData(snap, 0, 0);
      undoBtn.disabled = !undoStack.length;
    });
    const resetBtn = el("button", "btn btn-sm btn-ghost", icon("refresh"), "重置当前图");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", () => {
      if (!imgLoaded) return;
      ctx.drawImage(srcImg, 0, 0, canvas.width, canvas.height);
      undoStack = [];
      undoBtn.disabled = true;
    });

    side.append(
      el("div", "es-blk", el("span", "es-label", "工具"), toolGrid),
      colorBlk,
      el("div", "es-blk", sliderLabel, el("div", "slider-row", slider, sliderVal)),
      el("div", "es-blk", el("div", null, undoBtn, " ", resetBtn)),
      el("div", "es-blk", el("p", "es-tip", "保存后会替换当前待上传图片，生成时上传处理后的版本。"))
    );

    /* —— 撤销快照 —— */
    function pushUndo() {
      if (undoDisabled) return;
      try {
        const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
        undoStack = [...undoStack.slice(-(UNDO_MAX - 1)), snap];
        undoBtn.disabled = false;
      } catch {
        undoStack = [];
        undoBtn.disabled = true;
      }
    }

    /* —— 画布坐标 —— */
    function canvasPoint(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / Math.max(1, r.width) * canvas.width,
        y: (e.clientY - r.top) / Math.max(1, r.height) * canvas.height
      };
    }
    function scaleFactor() {
      const r = canvas.getBoundingClientRect();
      return canvas.width / Math.max(1, r.width);
    }

    function stampArea(pt) {
      const s = Math.max(16, areaSize * scaleFactor() / 2);
      const x = pt.x - s, y = pt.y - s, size = s * 2;
      if (tool === "mosaic") pixelateRegion(ctx, x, y, size, size, Math.max(8, Math.round(size / 6)));
      else blurRegion(ctx, x, y, size, size, Math.max(4, Math.round(size / 8)));
    }

    function drawShapePreview(to) {
      if (!shapeSnapshot || !startPt) return;
      ctx.putImageData(shapeSnapshot, 0, 0);
      const k = scaleFactor();
      const lw = Math.max(1.5, strokeSize * k / 3);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const x0 = startPt.x, y0 = startPt.y, x1 = to.x, y1 = to.y;
      if (tool === "rect") {
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else if (tool === "circle") {
        ctx.beginPath();
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (tool === "block") {
        ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else if (tool === "arrow") {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const head = Math.max(10 * k, lw * 3.2);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (!imgLoaded || saving || !e.isPrimary) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      const pt = canvasPoint(e);
      startPt = pt;
      lastPt = pt;
      pushUndo();
      if (isAreaTool()) {
        stampArea(pt);
      } else if (tool === "brush") {
        const k = scaleFactor();
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = Math.max(1.5, strokeSize * k / 3);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(0.75, strokeSize * k / 6), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        try { shapeSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height); }
        catch { shapeSnapshot = null; }
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drawing || !e.isPrimary) return;
      e.preventDefault();
      const pt = canvasPoint(e);
      if (isAreaTool()) {
        const step = Math.max(8, areaSize * scaleFactor() / 3);
        const dist = Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) {
          stampArea({ x: lastPt.x + (pt.x - lastPt.x) * i / n, y: lastPt.y + (pt.y - lastPt.y) * i / n });
        }
        lastPt = pt;
      } else if (tool === "brush") {
        const k = scaleFactor();
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, strokeSize * k / 3);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(lastPt.x, lastPt.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.restore();
        lastPt = pt;
      } else {
        drawShapePreview(pt);
      }
    });

    const endStroke = (e) => {
      if (!drawing) return;
      drawing = false;
      if (!isAreaTool() && tool !== "brush" && e && e.isPrimary) {
        drawShapePreview(canvasPoint(e));
      }
      shapeSnapshot = null;
      startPt = null;
      lastPt = null;
    };
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", () => { drawing = false; shapeSnapshot = null; });

    /* —— 头尾 —— */
    const closeBtn = el("button", "icon-btn", icon("x"));
    const head = el("div", "editor-head",
      el("h3", null, "编辑标注"),
      el("span", "eh-name", item.name),
      el("span", "spacer"),
      closeBtn
    );

    const saveBtn = el("button", "btn btn-primary", icon("check"), "保存修改");
    saveBtn.type = "button";
    const cancelBtn = el("button", "btn btn-ghost", "取消");
    cancelBtn.type = "button";
    const foot = el("div", "editor-foot", statusBar, cancelBtn, saveBtn);

    editor.append(head, el("div", "editor-main", stage, side), foot);
    const entry = openLayer(wrap, { persistent: true });
    const close = () => closeLayer(entry);
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

    saveBtn.addEventListener("click", async () => {
      if (saving) return;
      if (!imgLoaded) { setStatus("图片还在载入，请稍后再保存", true); return; }
      if (!state.localImages.some(x => x.id === item.id)) { setStatus("图片已被移除，无法保存", true); return; }
      saving = true;
      saveBtn.disabled = true;
      setStatus("正在保存…");
      try {
        const file = await canvasToFile(canvas, item.name, "edited");
        replaceLocalImageFile(item, file, { edited: true, maskStatus: "none", faceCount: 0, error: undefined });
        toast("已保存编辑标注，生成时将上传处理后的版本", "ok");
        close();
      } catch (e2) {
        setStatus(errMsg(e2), true);
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    });

    /* —— 载入图片 —— */
    const srcImg = new Image();
    srcImg.onload = () => {
      const w = srcImg.naturalWidth || srcImg.width;
      const h = srcImg.naturalHeight || srcImg.height;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(srcImg, 0, 0, w, h);
      imgLoaded = true;
      stageMsg.remove();
      if (w * h > UNDO_PIXEL_LIMIT) {
        undoDisabled = true;
        setStatus("当前图片较大，已关闭撤销记录以避免浏览器卡顿");
      } else {
        setStatus("在图片上拖动即可打码。");
      }
      syncSlider();
    };
    srcImg.onerror = () => {
      stageMsg.textContent = "图片无法读取，请更换文件";
    };
    srcImg.src = item.previewUrl;
    syncSlider();
  }

  /* ==================== U. 自动人脸马赛克 ==================== */

  let humanPromise = null;
  function loadHuman() {
    if (!humanPromise) {
      humanPromise = import(new URL("/vendor/human/human.esm.js", window.location.origin).href).then(mod => {
        const Human = mod.Human || mod.default;
        return new Human({
          backend: "webgl",
          modelBasePath: "/vendor/human/models/",
          cacheModels: true,
          validateModels: false,
          debug: false,
          warmup: "none",
          filter: { enabled: false },
          face: {
            enabled: true,
            detector: { maxDetected: 20, minConfidence: 0.15 },
            mesh: { enabled: false },
            iris: { enabled: false },
            description: { enabled: false },
            emotion: { enabled: false }
          },
          body: { enabled: false },
          hand: { enabled: false },
          object: { enabled: false },
          gesture: { enabled: false }
        });
      }).catch(e => {
        humanPromise = null;
        throw e;
      });
    }
    return humanPromise;
  }

  async function detectFacesHuman(img) {
    const human = await loadHuman();
    const res = await human.detect(img);
    if (res.error) throw new Error(String(res.error));
    /* 优先用归一化坐标 boxRaw × 自然尺寸：与模型内部缩放无关，小图也不会把码打到画外 */
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    return (res.face || [])
      .map(f => {
        const raw = Array.isArray(f.boxRaw) && f.boxRaw.length >= 4 && f.boxRaw.every(Number.isFinite) ? f.boxRaw : null;
        if (raw && W && H) return { x: raw[0] * W, y: raw[1] * H, width: raw[2] * W, height: raw[3] * H };
        const b = Array.isArray(f.box) && f.box.length >= 4 ? f.box : null;
        return b ? { x: b[0], y: b[1], width: b[2], height: b[3] } : null;
      })
      .filter(b => b && b.width > 0 && b.height > 0);
  }

  async function detectFacesNative(img) {
    const FD = globalThis.FaceDetector;
    if (!FD) return null;
    const det = new FD({ fastMode: true, maxDetectedFaces: 20 });
    const faces = await det.detect(img);
    return faces.map(f => f.boundingBox)
      .map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }))
      .filter(b => b.width > 0 && b.height > 0);
  }

  async function detectFaces(img) {
    try {
      return await detectFacesHuman(img);
    } catch (e) {
      console.warn("[face-mask] human 模块不可用，尝试原生 FaceDetector", e);
    }
    try {
      const native = await detectFacesNative(img);
      if (native) return native;
    } catch (e) {
      console.warn("[face-mask] FaceDetector 失败", e);
    }
    throw new Error("自动识别模型加载失败，请使用编辑标注");
  }

  function innerFaceBox(box, maxW, maxH) {
    const insetX = box.width * 0.22;
    const insetTop = box.height * 0.28;
    const insetBottom = box.height * 0.16;
    let x = box.x + insetX;
    let y = box.y + insetTop;
    let w = box.width - insetX * 2;
    let h = box.height - insetTop - insetBottom;
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(w, maxW - x); h = Math.min(h, maxH - y);
    return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
  }

  async function autoMask(item) {
    const live = () => state.localImages.find(x => x.id === item.id);
    const cur = live();
    if (!cur || cur.error || cur.maskStatus === "detecting") return;
    const fileAtStart = cur.file;
    cur.maskStatus = "detecting";
    renderAssets();
    toast("正在加载本地模型并识别人脸…", "info", 2400);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("图片无法读取，请更换文件"));
        im.src = cur.previewUrl;
      });
      const faces = await detectFaces(img);
      const now = live();
      if (!now || now.file !== fileAtStart) {
        toast("图片已更新，已取消本次自动马赛克结果", "info");
        return;
      }
      if (!faces.length) {
        now.maskStatus = "none";
        renderAssets();
        toast("未发现人脸，可手动编辑", "info");
        return;
      }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      for (const box of faces) ellipseMosaic(ctx, innerFaceBox(box, w, h), 16);
      const file = await canvasToFile(canvas, now.name, "auto-mosaic");
      const still = live();
      if (!still || still.file !== fileAtStart) {
        toast("图片已更新，已取消本次自动马赛克结果", "info");
        return;
      }
      replaceLocalImageFile(still, file, { maskStatus: "masked", faceCount: faces.length, edited: false });
      toast(`已为 ${item.name} 自动马赛克 ${faces.length} 张人脸`, "ok");
    } catch (e) {
      const now = live();
      if (now) { now.maskStatus = "none"; renderAssets(); }
      toast(errMsg(e), "err");
    }
  }

  /* ==================== V. 事件绑定 ==================== */

  /* 模式切换：指挥条与生成器头部两组按钮统一代理 */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn || btn.dataset.mode === state.mode) return;
    state.mode = btn.dataset.mode;
    renderMode();
  });

  /* 提示词 */
  promptEl.addEventListener("input", () => {
    autoGrow();
    renderPromptCount();
    updateMention();
    renderQuoteDebounced();
  });
  promptEl.addEventListener("click", updateMention);
  promptEl.addEventListener("blur", () => {
    setTimeout(() => { mentionState = null; renderMention(); }, 140);
  });
  promptEl.addEventListener("keydown", (e) => {
    if (mentionKeydown(e)) { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  const renderQuoteDebounced = debounce(renderQuote, 200);

  $("#btn-at").addEventListener("click", () => {
    const pos = promptEl.selectionStart ?? promptEl.value.length;
    promptEl.value = promptEl.value.slice(0, pos) + "@" + promptEl.value.slice(promptEl.selectionEnd ?? pos);
    promptEl.focus();
    promptEl.setSelectionRange(pos + 1, pos + 1);
    updateMention();
  });

  /* 上传 */
  const fileImg = $("#file-img");
  const fileAud = $("#file-audio");
  $("#btn-up-img").addEventListener("click", () => fileImg.click());
  $("#btn-up-audio").addEventListener("click", () => fileAud.click());
  fileImg.addEventListener("change", () => { addImages(fileImg.files); fileImg.value = ""; });
  fileAud.addEventListener("change", () => { addAudios(fileAud.files); fileAud.value = ""; });
  $("#btn-url").addEventListener("click", openUrlModal);

  /* 拖拽 */
  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!state.submitting) dropzone.classList.add("over");
  });
  dropzone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("over");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("over");
    addDroppedFiles(e.dataTransfer.files);
  });

  /* 剪贴板粘贴（截图 / 图片文件） */
  document.addEventListener("paste", (e) => {
    if (state.view !== "studio" || layerStack.length) return;
    const files = Array.from(e.clipboardData && e.clipboardData.files || []);
    if (!files.length) return;
    /* 粘贴文本不拦截；剪贴板里有文件才接管 */
    e.preventDefault();
    addDroppedFiles(files);
  });

  /* 素材库浮窗（Dock 启动） */
  $("#dock-library").addEventListener("click", () => {
    const win = $("#win-library");
    const show = win.classList.toggle("show");
    $("#dock-library").classList.toggle("on", show);
    if (show) refreshLibrary({ silent: true });
  });
  const barInput = $("#bar-input");
  barInput.addEventListener("input", () => {
    promptEl.value = barInput.value;
    sizeBarInput();
    autoGrow();
    renderPromptCount();
    renderQuoteDebounced();
  });
  barInput.addEventListener("keydown", (e) => {
    /* 回车生成；Shift+回车换行；中文输入法选词回车不触发 */
    if (e.key === "Enter" && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submit();
    }
  });
  $("#bar-settings").addEventListener("click", () => setBarPanel(!barPanelOpen));
  document.addEventListener("pointerdown", (e) => {
    if (!barPanelOpen) return;
    const panel = $("#bar-panel");
    const chip = $("#bar-settings");
    if (panel.contains(e.target) || chip.contains(e.target)) return;
    setBarPanel(false);
  }, true);
  $("#bar-expand").addEventListener("click", () => setComposer(true));
  $("#bar-go").addEventListener("click", submit);

  /* 指挥条「+」：不展开生成器也能传图、传音频、贴链接、开素材库 */
  $("#bar-attach").addEventListener("click", () => {
    openPop($("#bar-attach"), (pop, close) => {
      pop.classList.add("attach-pop");
      pop.append(el("div", "pop-head", "添加素材"));
      const mk = (ico, title, sub, fn) => {
        const item = el("button", "pop-item", icon(ico, 15),
          el("div", "pi-main", el("div", "pi-title", title), sub ? el("div", "pi-sub", sub) : null));
        item.addEventListener("click", () => { close(); fn(); });
        pop.append(item);
      };
      mk("upload", "上传图片", `jpg / png / webp 等，最多 ${state.mode === "video" && isFLF() ? 2 : 9} 张`, () => fileImg.click());
      if (state.mode === "video") {
        if (audioAllowed()) mk("music", "上传音频", "mp3 / wav，单段 2-15s", () => fileAud.click());
        else pop.append(el("div", "pop-hint", "首尾帧模式不支持音频"));
      }
      mk("link", "粘贴素材链接", "图片 / 音频直链，每行一个", openUrlModal);
      pop.append(el("div", "pop-sep"));
      mk("box", "打开素材库", "历史素材点击即可加入引用", () => {
        const win = $("#win-library");
        if (!win.classList.contains("show")) {
          win.classList.add("show");
          $("#dock-library").classList.add("on");
          refreshLibrary({ silent: true });
        }
      });
    }, { avoid: $(".cmdbar") });
  });

  /* 文件直接拖到指挥条上 */
  const cmdbarEl = $(".cmdbar");
  cmdbarEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!state.submitting) cmdbarEl.classList.add("over");
  });
  cmdbarEl.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (!cmdbarEl.contains(e.relatedTarget)) cmdbarEl.classList.remove("over");
  });
  cmdbarEl.addEventListener("drop", (e) => {
    e.preventDefault();
    cmdbarEl.classList.remove("over");
    addDroppedFiles(e.dataTransfer.files);
  });
  $("#composer-collapse").addEventListener("click", () => setComposer(false));
  $("#we-open").addEventListener("click", () => setComposer(true));
  $("#win-library-close").addEventListener("click", () => {
    $("#win-library").classList.remove("show");
    $("#dock-library").classList.remove("on");
  });
  $("#lib-refresh").addEventListener("click", (e) => {
    e.stopPropagation();
    refreshLibrary();
  });

  /* 顶栏 */
  $("#btn-announcements").addEventListener("click", openAnnouncementCenter);
  $("#points-pill").addEventListener("click", (e) => {
    if (e.target.closest("#pp-refresh")) return;
    openBalancePop();
  });
  $("#pp-refresh").addEventListener("click", (e) => {
    e.stopPropagation();
    refreshBalance();
  });
  $("#btn-license").addEventListener("click", () => {
    openPop($("#btn-license"), (pop, close) => {
      const key = state.licenseKey || "";
      const masked = key.length > 10 ? `${key.slice(0, 6)}····${key.slice(-4)}` : key || "--";
      pop.append(el("div", "pop-head", "当前访问码"));
      pop.append(el("div", "pop-item", el("div", "pi-main", el("div", "pi-title mono", masked))));
      pop.append(el("div", "pop-sep"));
      const copyBtn = el("button", "pop-item", el("div", "pi-main", el("div", "pi-title", "复制访问码")));
      copyBtn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(key); toast("访问码已复制", "ok", 1600); } catch { toast("复制失败，请手动复制", "err"); }
        close();
      });
      const outBtn = el("button", "pop-item", el("div", "pi-main", el("div", "pi-title", "更换访问码")));
      outBtn.addEventListener("click", () => { close(); logout(); });
      pop.append(copyBtn, outBtn);
    });
  });

  /* 任务区 */
  $("#btn-clear-tasks").addEventListener("click", clearTasks);
  $("#btn-go").addEventListener("click", submit);

  /* 激活 */
  $("#gate-form").addEventListener("submit", handleActivate);

  /* 全局快捷键 */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (activePop) { closePop(); return; }
      if (barPanelOpen) { setBarPanel(false); return; }
      if (closeTopLayer()) return;
      const libWin = $("#win-library");
      if (libWin && libWin.classList.contains("show")) {
        libWin.classList.remove("show");
        $("#dock-library").classList.remove("on");
        return;
      }
      if (state.composerOpen && document.activeElement !== promptEl) setComposer(false);
    }
  });
  window.addEventListener("resize", () => { closePop(); positionMention(); sizeBarInput(); });
  const masonryRelayout = debounce(() => renderTasks(), 160);
  window.addEventListener("resize", masonryRelayout);
  /* 页面滚动时关闭弹出菜单（锚点会错位），但菜单内部滚动不受影响；@ 菜单跟随重定位 */
  window.addEventListener("scroll", (e) => {
    positionMention();
    if (activePop && e.target instanceof Node && activePop.pop.contains(e.target)) return;
    closePop();
  }, true);

  /* ==================== W. 主题与启动 ==================== */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#f4f4f6" : "#151517";
    for (const use of $$(".theme-toggle use")) {
      use.setAttribute("href", theme === "light" ? "#i-moon" : "#i-sun");
    }
  }
  applyTheme(localStorage.getItem(LS_THEME) === "dark" ? "dark" : "light");
  for (const btn of $$(".theme-toggle")) {
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      localStorage.setItem(LS_THEME, next);
      applyTheme(next);
    });
  }

  /* 菜单栏时钟 */
  function tickClock() {
    const node = $("#menu-clock");
    if (!node) return;
    const d = new Date();
    const wd = "日一二三四五六"[d.getDay()];
    node.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${wd} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  tickClock();
  setInterval(tickClock, 30e3);

  boot();
})();
