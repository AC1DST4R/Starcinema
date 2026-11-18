/* ST4R Cinema — static build (no server; everything lives in this browser) */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE_KEY = "st4r-cinema.v1";
const IMG = "https://image.tmdb.org/t/p";

const state = {
  movies: [],
  folders: [],
  tmdbKey: "",
  config: { hasTmdbKey: false },
  query: "",
  folder: null,
};

/* --------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    state.movies = Array.isArray(raw.movies) ? raw.movies : [];
    state.folders = Array.isArray(raw.folders) ? raw.folders : [];
    state.tmdbKey = typeof raw.tmdbKey === "string" ? raw.tmdbKey : "";
  } catch {
    state.movies = [];
    state.folders = [];
    state.tmdbKey = "";
  }
  state.config.hasTmdbKey = Boolean(state.tmdbKey);
}

function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ movies: state.movies, folders: state.folders, tmdbKey: state.tmdbKey }),
    );
  } catch {
    toast("This browser refused to save the library (storage may be full).", 6000);
  }
}

let toastTimer = null;
function toast(message, ms = 4200) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

const videoEl = $("#video");

function fmtClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function minutesLeft(movie) {
  if (!movie.progress?.duration) return 0;
  return Math.max(1, Math.round((movie.progress.duration - movie.progress.position) / 60));
}

function progressPct(movie) {
  if (!movie.progress?.duration) return 0;
  return Math.min(100, (movie.progress.position / movie.progress.duration) * 100);
}

function metaLine(movie) {
  const bits = [];
  if (movie.year) bits.push(movie.year);
  if (movie.rating) bits.push(`★ ${movie.rating}`);
  bits.push(movie.url ? "Stream link" : "No link yet");
  return bits;
}

function replaceMovie(movie) {
  const index = state.movies.findIndex((m) => m.id === movie.id);
  if (index >= 0) state.movies[index] = movie;
  else state.movies.push(movie);
}

/* ------------------------------------------------------------------ tmdb */

async function tmdb(path, params = {}) {
  if (!state.tmdbKey) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = { accept: "application/json" };
  if (state.tmdbKey.startsWith("eyJ")) headers.Authorization = `Bearer ${state.tmdbKey}`;
  else url.searchParams.set("api_key", state.tmdbKey);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401) throw new Error("TMDB rejected that key (401).");
    throw new Error(`TMDB request failed (${res.status}).`);
  }
  return res.json();
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[\W_]+/g, " ")
    .trim();
}

function toCandidate(result) {
  const year =
    typeof result.release_date === "string" && result.release_date.length >= 4
      ? Number(result.release_date.slice(0, 4)) || null
      : null;
  return {
    tmdbId: result.id,
    title: result.title || result.original_title || "Untitled",
    year,
    overview: result.overview || "",
    poster: result.poster_path ? `${IMG}/w500${result.poster_path}` : null,
    backdrop: result.backdrop_path ? `${IMG}/w1280${result.backdrop_path}` : null,
    rating:
      typeof result.vote_average === "number" && result.vote_average > 0
        ? Math.round(result.vote_average * 10) / 10
        : null,
  };
}

async function tmdbSearch(query, year = null) {
  if (!query.trim() || !state.tmdbKey) return [];
  const data = await tmdb("/search/movie", { query, year: year ?? undefined, include_adult: "false" });
  const results = (data?.results ?? []).map(toCandidate);
  for (const hit of results) {
    const a = normalize(hit.title);
    const b = normalize(query);
    let score = a === b ? 100 : a.startsWith(b) || b.startsWith(a) ? 70 : a.includes(b) ? 50 : 10;
    if (year && hit.year === year) score += 40;
    else if (year && hit.year && Math.abs(hit.year - year) <= 1) score += 15;
    if (!hit.poster) score -= 20;
    hit.score = score;
  }
  results.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
  return results;
}

/* ------------------------------------------------------------- filenames */

const JUNK = new RegExp(
  "\\b(" +
    [
      "2160p", "1080p", "720p", "480p", "4k", "uhd", "bluray", "brrip", "bdrip", "remux",
      "webrip", "web dl", "webdl", "hdtv", "dvdrip", "x264", "x265", "h264", "h265", "hevc",
      "av1", "aac", "ac3", "dts", "atmos", "hdr", "proper", "repack", "extended", "imax",
    ].join("|") +
    ")\\b",
  "i",
);

function parseName(rawInput) {
  const input = String(rawInput).split("/").pop().split("?")[0];
  let text = decodeURIComponent(input).replace(/\.[a-z0-9]{2,5}$/i, "");
  text = text.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();

  let year = null;
  const match = text.match(/(?:^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]\.\-])/);
  if (match) {
    year = Number(match[1]);
    text = text.slice(0, match.index).trim();
  }
  text = text.replace(/[[{][^\]}]*[\]}]/g, " ");
  const junkAt = text.search(JUNK);
  if (junkAt > 0) text = text.slice(0, junkAt);
  text = text.replace(/[\s\-–_([{]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text) text = "Untitled";
  return { title: text, year };
}

/* ------------------------------------------------------- focus / remote */

let focusedEl = null;

function navLayer() {
  if (!$("#player").hidden) return $("#player");
  if (!$("#modal").hidden) return $("#modal");
  return document.body;
}

function navElements() {
  const layer = navLayer();
  return $$("[data-nav]", layer).filter((el) => {
    if (el.disabled) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  });
}

function setFocus(el, scroll = true) {
  if (!el) return;
  if (focusedEl && focusedEl !== el) focusedEl.classList.remove("nav-focus");
  focusedEl = el;
  el.classList.add("nav-focus");
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* not focusable */
  }
  if (scroll) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

function moveFocus(direction) {
  const els = navElements();
  if (!els.length) return;

  if (!focusedEl || !els.includes(focusedEl)) {
    setFocus($(".card[data-nav]") || els[0]);
    return;
  }

  const fromRect = focusedEl.getBoundingClientRect();
  const fx = fromRect.left + fromRect.width / 2;
  const fy = fromRect.top + fromRect.height / 2;
  let best = null;
  let bestScore = Infinity;

  for (const el of els) {
    if (el === focusedEl) continue;
    const rect = el.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - fx;
    const dy = rect.top + rect.height / 2 - fy;
    let primary;
    let secondary;

    if (direction === "left" || direction === "right") {
      if (direction === "right" ? dx < 6 : dx > -6) continue;
      primary = Math.abs(dx);
      secondary = Math.abs(dy);
    } else {
      if (direction === "down" ? dy < 6 : dy > -6) continue;
      primary = Math.abs(dy);
      secondary = Math.abs(dx);
    }
    const score = primary + secondary * 2.4;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) setFocus(best);
}

function activateFocused() {
  if (!focusedEl || !focusedEl.isConnected) return;
  if (focusedEl.tagName === "INPUT") {
    focusedEl.focus();
    return;
  }
  focusedEl.click();
}

function back() {
  if (!$("#player").hidden) return closePlayer();
  if (!$("#modal").hidden) return closeModal();
  if (state.folder) {
    state.folder = null;
    render();
    const chip = $('[data-folder=""]');
    if (chip) setFocus(chip, false);
    return;
  }
  if (state.query) {
    state.query = "";
    $("#search").value = "";
    render();
  }
}

/* --------------------------------------------------------------- cards */

function cardHtml(movie, opts = {}) {
  const pct = progressPct(movie);
  const left = minutesLeft(movie);
  const poster = movie.poster
    ? `<img src="${esc(movie.poster)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
    : "";
  const sub = opts.continueWatching && left ? `${left} min left` : metaLine(movie).join(" · ");

  return `
    <button class="card" data-nav data-id="${esc(movie.id)}" title="${esc(movie.title)}">
      <div class="poster">
        <div class="fallback">${esc(movie.title)}</div>
        ${poster}
        <span class="badge">${movie.url ? "Link" : "Unlinked"}</span>
        <span class="hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/></svg>${pct ? "Resume" : "Play"}</span>
        ${pct ? `<div class="progress"><span style="width:${pct.toFixed(2)}%"></span></div>` : ""}
      </div>
      <div class="card-title">${esc(movie.title)}</div>
      <div class="card-sub">${esc(sub)}</div>
    </button>`;
}

function shelfHtml(title, items, opts = {}) {
  if (!items.length) return "";
  return `
    <section class="shelf">
      <div class="shelf-head">
        <h2 class="shelf-title">${esc(title)}<span class="count">${items.length}</span></h2>
      </div>
      <div class="row">${items.map((m) => cardHtml(m, opts)).join("")}</div>
    </section>`;
}

/* ------------------------------------------------------------------ nav */

function renderNav() {
  const nav = $("#nav");
  const items = [{ id: null, name: "Library", count: state.movies.length }].concat(
    state.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      count: state.movies.filter((m) => m.folderId === folder.id).length,
    })),
  );

  nav.innerHTML =
    items
      .map(
        (item) => `<button class="nav-tab${state.folder === item.id ? " is-active" : ""}" data-nav data-folder="${item.id ?? ""}">${esc(item.name)}<span class="n">${item.count}</span></button>`,
      )
      .join("") + `<button class="nav-tab nav-manage" data-nav data-manage-folders>Folders</button>`;

  $$("[data-folder]", nav).forEach((btn) => {
    btn.onclick = () => {
      state.folder = btn.dataset.folder || null;
      if (state.query) {
        state.query = "";
        $("#search").value = "";
      }
      render();
      const again = $(`[data-folder="${state.folder ?? ""}"]`);
      if (again) setFocus(again, false);
    };
  });
  $("[data-manage-folders]", nav).onclick = () => openFolders();
}

/* ---------------------------------------------------------------- render */

function render() {
  renderNav();

  const hero = $("#hero");
  const content = $("#content");
  const empty = $("#empty");
  const notice = $("#notice");
  const all = state.folder ? state.movies.filter((m) => m.folderId === state.folder) : state.movies;

  notice.hidden = Boolean(state.tmdbKey);
  if (!state.tmdbKey) {
    $("#notice-text").textContent =
      "No TMDB key yet — links still play, but covers and synopses stay blank until you add one.";
  }

  if (!state.movies.length) {
    hero.hidden = true;
    hero.innerHTML = "";
    content.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const sorted = [...all].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));

  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    const hits = all.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        String(m.year ?? "").includes(q) ||
        (m.overview || "").toLowerCase().includes(q),
    );
    hero.hidden = true;
    content.innerHTML = hits.length
      ? `<div class="shelves"><div class="shelf-head"><h2 class="shelf-title">Results for “${esc(state.query.trim())}”<span class="count">${hits.length}</span></h2></div><div class="grid">${hits.map((m) => cardHtml(m)).join("")}</div></div>`
      : `<div class="shelves"><div class="shelf-head"><h2 class="shelf-title">No matches for “${esc(state.query.trim())}”</h2></div><div class="grid"></div></div>`;
    return;
  }

  if (!all.length) {
    const folderName = state.folders.find((f) => f.id === state.folder)?.name || "This folder";
    hero.hidden = true;
    hero.innerHTML = "";
    content.innerHTML = `
      <div class="shelves">
        <div class="shelf-head"><h2 class="shelf-title">${esc(folderName)} is empty</h2></div>
        <p class="shelf-empty">Add titles to this folder from a film's details page.</p>
      </div>`;
    return;
  }

  const continueList = all
    .filter((m) => progressPct(m) > 0 && progressPct(m) < 95)
    .sort((a, b) => String(b.progress?.updatedAt).localeCompare(String(a.progress?.updatedAt)));

  const featured = continueList[0] || sorted.find((m) => m.backdrop) || sorted[0];
  const art = featured.backdrop || featured.poster;
  const featuredPct = progressPct(featured);

  hero.hidden = false;
  hero.className = "hero" + (art ? "" : " no-art");
  hero.style.backgroundImage = art ? `url("${art}")` : "none";
  hero.innerHTML = `
    <div class="hero-content">
      <div class="hero-kicker">${featuredPct ? "Continue watching" : "Recently added"}</div>
      <h1>${esc(featured.title)}</h1>
      <div class="hero-meta">
        ${featured.year ? `<span>${featured.year}</span><span class="dot"></span>` : ""}
        ${featured.rating ? `<span>★ ${featured.rating}</span><span class="dot"></span>` : ""}
        <span class="chip-static">${featured.url ? "LINK" : "NO LINK"}</span>
        <span>${featured.url ? "Direct stream" : "Add a stream link"}</span>
        ${featuredPct ? `<span class="dot"></span><span>${minutesLeft(featured)} min left</span>` : ""}
      </div>
      ${featured.overview ? `<p>${esc(featured.overview)}</p>` : ""}
      <div class="hero-actions">
        <button class="btn primary" data-nav data-play="${esc(featured.id)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/></svg>
          ${featuredPct ? "Resume" : "Play"}
        </button>
        <button class="btn ghost" data-nav data-detail="${esc(featured.id)}">Details</button>
      </div>
      ${featuredPct ? `<div class="hero-progress"><span style="width:${featuredPct.toFixed(2)}%"></span></div>` : ""}
    </div>`;

  const shelves = [];
  if (continueList.length) shelves.push(shelfHtml("Continue Watching", continueList, { continueWatching: true }));
  shelves.push(shelfHtml("Recently Added", sorted.slice(0, 12)));
  if (all.length > 12 || state.folder) {
    const title = state.folder
      ? state.folders.find((f) => f.id === state.folder)?.name || "Folder"
      : "Your Library";
    shelves.push(shelfHtml(title, sorted));
  }
  content.innerHTML = `<div class="shelves">${shelves.join("")}</div>`;
}

/* ---------------------------------------------------------------- player */

let playerMovie = null;

function saveProgress() {
  if (!playerMovie || !videoEl.duration || !isFinite(videoEl.duration)) return;
  const position = videoEl.currentTime;
  const duration = videoEl.duration;
  const movie = state.movies.find((m) => m.id === playerMovie.id);
  if (!movie) return;
  if (!duration || position < 5 || position / duration > 0.95) delete movie.progress;
  else movie.progress = { position, duration, updatedAt: new Date().toISOString() };
  saveStore();
}

function play(movie) {
  if (!movie.url) {
    openDetail(movie.id);
    toast("Add a stream link for this film first.", 4200);
    return;
  }
  const player = $("#player");
  const msg = $("#player-msg");
  const start = movie.progress?.position || 0;

  playerMovie = movie;
  $("#player-title").textContent = `${movie.title}${movie.year ? ` · ${movie.year}` : ""}`;
  msg.hidden = true;
  videoEl.onerror = () => {
    msg.hidden = false;
    msg.textContent =
      "This link didn't load. Check that it points straight at a video file and allows playback here.";
  };
  videoEl.src = movie.url;

  if (start > 5) {
    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        if (start < (videoEl.duration || Infinity) * 0.95) {
          videoEl.currentTime = start;
          toast(`Resumed at ${fmtClock(start)}`, 2400);
        }
      },
      { once: true },
    );
  }

  player.hidden = false;
  document.body.style.overflow = "hidden";
  videoEl.play().catch(() => {});
  const closeBtn = $("#player-close");
  if (closeBtn) setFocus(closeBtn, false);
}

function closePlayer() {
  saveProgress();
  videoEl.pause();
  videoEl.removeAttribute("src");
  videoEl.load();
  $("#player").hidden = true;
  $("#player-msg").hidden = true;
  playerMovie = null;
  if ($("#modal").hidden) document.body.style.overflow = "";
  render();
  const first = $(".hero [data-nav]") || $(".card[data-nav]");
  if (first) setFocus(first, false);
}

videoEl.addEventListener("timeupdate", () => {
  if (!playerMovie) return;
  if (!videoEl.lastSave || Date.now() - videoEl.lastSave > 7000) {
    videoEl.lastSave = Date.now();
    saveProgress();
  }
});
videoEl.addEventListener("pause", () => saveProgress());
videoEl.addEventListener("ended", () => {
  if (!playerMovie) return;
  const movie = state.movies.find((m) => m.id === playerMovie.id);
  if (movie) {
    delete movie.progress;
    saveStore();
  }
});

/* ----------------------------------------------------------------- modal */

function openModal(html, slim = false) {
  const back = $("#modal");
  const panel = $("#modal-panel");
  panel.className = `modal${slim ? " slim" : ""}`;
  panel.innerHTML = html;
  back.hidden = false;
  document.body.style.overflow = "hidden";
  back.onclick = (event) => {
    if (event.target === back) closeModal();
  };
  $$("[data-close]", panel).forEach((btn) => (btn.onclick = closeModal));
  return panel;
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-panel").innerHTML = "";
  focusedEl = null;
  if ($("#player").hidden) document.body.style.overflow = "";
}

function focusModal() {
  const panel = $("#modal-panel");
  const first = $(".btn.primary[data-nav]:not([disabled])", panel) || $("[data-nav]", panel);
  if (first) setFocus(first, false);
}

const X_BTN = `<button class="close-x" data-nav data-close title="Close">
  <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
</button>`;

/* -------------------------------------------------------------- settings */

function openSettings() {
  const panel = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>TMDB connection</h2>
        <p>Covers, backdrops, years and synopses come from The Movie Database. A free API key takes about a minute.</p>
      </div>
      ${X_BTN}
    </div>
    <div class="modal-body">
      <div class="field">
        <label for="key">API key (v3)</label>
        <input id="key" type="password" data-nav placeholder="Paste your TMDB key" autocomplete="off" spellcheck="false" />
        <div class="hintline">Create one at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">themoviedb.org/settings/api</a> → “API Key”. It is stored only in this browser's local storage.</div>
      </div>
      <div class="hintline" id="key-status">${state.tmdbKey ? "A key is already saved. Enter a new one to replace it." : "No key yet."}</div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-nav data-close>Cancel</button>
      <button class="btn primary" data-nav id="key-save">Save &amp; test</button>
    </div>`,
    true,
  );

  const save = async () => {
    const input = $("#key", panel);
    const btn = $("#key-save", panel);
    const key = input.value.trim();
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> Checking…`;

    if (!key) {
      state.tmdbKey = "";
      state.config.hasTmdbKey = false;
      saveStore();
      closeModal();
      render();
      toast("TMDB key cleared.");
      return;
    }

    const previous = state.tmdbKey;
    state.tmdbKey = key;
    try {
      await tmdb("/configuration");
      state.config.hasTmdbKey = true;
      saveStore();
      closeModal();
      render();
      toast("TMDB connected.");
    } catch (err) {
      state.tmdbKey = previous;
      state.config.hasTmdbKey = Boolean(previous);
      $("#key-status", panel).textContent = `That key didn't work — ${err.message}`;
      btn.disabled = false;
      btn.textContent = "Save & test";
    }
  };

  $("#key-save", panel).onclick = save;
  $("#key", panel).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  setFocus($("#key", panel), false);
}

/* ------------------------------------------------------------------ add */

function openAddModal(tab = "link") {
  const panel = openModal(`
    <div class="modal-head">
      <div>
        <h2>Add movies</h2>
        <p>${state.folder ? `New titles land in “${esc(state.folders.find((f) => f.id === state.folder)?.name || "this folder")}”.` : "Paste a direct video link, or build the shelf from TMDB first."}</p>
      </div>
      ${X_BTN}
    </div>
    <div class="modal-body">
      <div class="tabs">
        <button class="tab" data-nav data-mode="link">Direct link</button>
        <button class="tab" data-nav data-mode="tmdb">Search TMDB</button>
      </div>
      <div id="tab-body"></div>
    </div>
  `);

  const body = $("#tab-body", panel);
  const setMode = (mode) => {
    $$(".tab", panel).forEach((t) => t.classList.toggle("is-active", t.dataset.mode === mode));
    body.innerHTML = mode === "link" ? linkTabHtml() : tmdbTabHtml();
    if (mode === "link") wireLinkTab(panel, body);
    else wireTmdbTab(panel, body);
    const input = $("input", body);
    if (input) setFocus(input, false);
  };
  $$(".tab", panel).forEach((t) => (t.onclick = () => setMode(t.dataset.mode)));
  setMode(tab);
  focusModal();
}

function linkTabHtml() {
  return `
    <div class="field">
      <label for="u-url">Media URL</label>
      <input id="u-url" data-nav placeholder="https://example.com/movie.mp4" spellcheck="false" />
      <div class="hintline">A direct link to a video file the browser can play (MP4, WebM, HLS).</div>
    </div>
    <div class="field">
      <label for="u-title">Title</label>
      <input id="u-title" data-nav placeholder="Leave blank to use the link's filename" />
    </div>
    <div class="field">
      <label for="u-poster">Poster URL (optional)</label>
      <input id="u-poster" data-nav placeholder="Leave blank for the TMDB poster" spellcheck="false" />
    </div>
    <div class="modal-foot" style="padding:18px 0 0">
      <button class="btn primary" data-nav id="u-add">Add to library</button>
    </div>`;
}

function wireLinkTab(panel, body) {
  const add = async () => {
    const url = $("#u-url", body).value.trim();
    if (!/^https?:\/\//i.test(url)) return toast("Paste a full http(s) media URL.");
    if (state.movies.some((m) => m.url === url)) return toast("That link is already in your library.");

    const typed = $("#u-title", body).value.trim();
    const poster = $("#u-poster", body).value.trim();
    const guessed = parseName(typed || url);
    const title = typed || guessed.title;
    const btn = $("#u-add", body);
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> Adding…`;

    let candidate = null;
    if (state.tmdbKey) {
      try {
        candidate = (await tmdbSearch(title, guessed.year))[0] || null;
      } catch {
        candidate = null;
      }
    }

    const movie = {
      id: uid(),
      title: candidate?.title || title,
      year: candidate?.year ?? guessed.year,
      overview: candidate?.overview || "",
      poster: poster || candidate?.poster || null,
      backdrop: candidate?.backdrop || null,
      rating: candidate?.rating ?? null,
      tmdbId: candidate?.tmdbId ?? null,
      folderId: state.folder,
      url,
      addedAt: new Date().toISOString(),
    };
    state.movies.push(movie);
    saveStore();
    closeModal();
    render();
    toast("Link added to your library.");
  };
  $("#u-add", body).onclick = add;
  $("#u-url", body).focus();
}

function tmdbTabHtml() {
  return `
    <div class="field">
      <div class="inline">
        <input id="t-q" data-nav placeholder="Search TMDB for a film" spellcheck="false" />
        <button class="btn ghost small" data-nav id="t-go">Search</button>
      </div>
      <div class="hintline">Pick a film to add its poster and details, then attach a stream link from its page.</div>
    </div>
    <div class="match-list" id="t-results"><div class="browser-empty">${state.tmdbKey ? "Search for a title." : "Add a TMDB key in settings to search."}</div></div>`;
}

function wireTmdbTab(panel, body) {
  const results = $("#t-results", body);

  const run = async () => {
    if (!state.tmdbKey) return toast("Add a TMDB key in settings first.");
    results.innerHTML = `<div class="browser-empty">Searching…</div>`;
    try {
      const list = await tmdbSearch($("#t-q", body).value.trim());
      if (!list.length) {
        results.innerHTML = `<div class="browser-empty">No matches. Try a shorter title.</div>`;
        return;
      }
      results.innerHTML = list
        .map(
          (hit) => `
          <button class="match-row" data-nav data-tmdb="${hit.tmdbId}">
            ${hit.poster ? `<img src="${esc(hit.poster)}" alt="" loading="lazy" />` : `<div style="width:42px;flex:none"></div>`}
            <div>
              <div class="m-title">${esc(hit.title)}</div>
              <div class="m-sub">${hit.year || "—"}${hit.rating ? ` · ★ ${hit.rating}` : ""}</div>
              ${hit.overview ? `<div class="m-ov">${esc(hit.overview)}</div>` : ""}
            </div>
          </button>`,
        )
        .join("");

      $$("[data-tmdb]", results).forEach((row) => {
        row.onclick = () => {
          const hit = list.find((item) => String(item.tmdbId) === row.dataset.tmdb);
          if (!hit) return;
          const movie = {
            id: uid(),
            title: hit.title,
            year: hit.year,
            overview: hit.overview,
            poster: hit.poster,
            backdrop: hit.backdrop,
            rating: hit.rating,
            tmdbId: hit.tmdbId,
            folderId: state.folder,
            url: null,
            addedAt: new Date().toISOString(),
          };
          state.movies.push(movie);
          saveStore();
          closeModal();
          render();
          openDetail(movie.id);
          toast("Added — paste a stream link for it.", 5000);
        };
      });
    } catch (err) {
      results.innerHTML = `<div class="browser-empty">${esc(err.message)}</div>`;
    }
  };

  $("#t-go", body).onclick = run;
  $("#t-q", body).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      run();
    }
  });
}

/* --------------------------------------------------------------- folders */

function openFolders() {
  const countFor = (id) => state.movies.filter((m) => m.folderId === id).length;
  const rows = state.folders.length
    ? state.folders
        .map(
          (folder) => `
        <div class="folder-line">
          <input class="folder-name" data-nav data-rename-id="${esc(folder.id)}" value="${esc(folder.name)}" spellcheck="false" />
          <span class="cnt">${countFor(folder.id)} film${countFor(folder.id) === 1 ? "" : "s"}</span>
          <button class="icon-btn" data-nav data-del-id="${esc(folder.id)}" title="Delete folder">
            <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
          </button>
        </div>`,
        )
        .join("")
    : `<div class="browser-empty">No folders yet. Create one below, then add films from their details page.</div>`;

  const panel = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>Folders</h2>
        <p>Group the library into collections. Each folder appears as a tab and gets its own row.</p>
      </div>
      ${X_BTN}
    </div>
    <div class="modal-body">
      <div class="folder-list">${rows}</div>
      <div class="folder-form">
        <input id="f-new" data-nav placeholder="New folder name" spellcheck="false" />
        <button class="btn primary small" data-nav id="f-create">Create</button>
      </div>
    </div>`,
    true,
  );

  const reopen = () => openFolders();

  $$("[data-rename-id]", panel).forEach((input) => {
    const commit = () => {
      const name = input.value.trim();
      const folder = state.folders.find((f) => f.id === input.dataset.renameId);
      if (!folder || !name || name === folder.name) return;
      folder.name = name;
      saveStore();
      render();
      toast("Folder renamed.");
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
      }
    });
  });

  $$("[data-del-id]", panel).forEach((btn) => {
    let armed = false;
    btn.onclick = () => {
      if (!armed) {
        armed = true;
        btn.classList.add("is-armed");
        btn.title = "Click again to delete";
        return;
      }
      const id = btn.dataset.delId;
      state.folders = state.folders.filter((f) => f.id !== id);
      for (const movie of state.movies) if (movie.folderId === id) movie.folderId = null;
      if (state.folder === id) state.folder = null;
      saveStore();
      render();
      reopen();
      toast("Folder removed.");
    };
  });

  const create = () => {
    const name = $("#f-new", panel).value.trim();
    if (!name) return toast("Name the folder first.");
    state.folders.push({ id: uid(), name, createdAt: new Date().toISOString() });
    saveStore();
    render();
    reopen();
    toast(`Folder “${name}” created.`);
  };
  $("#f-create", panel).onclick = create;
  $("#f-new", panel).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      create();
    }
  });

  focusModal();
}

function assignFolder(movie, folderId) {
  movie.folderId = folderId;
  saveStore();
  render();
  openDetail(movie.id);
  toast(folderId ? "Moved to folder." : "Removed from folder.");
}

/* --------------------------------------------------------------- detail */

function openDetail(id) {
  const movie = state.movies.find((m) => m.id === id);
  if (!movie) return;
  const art = movie.backdrop || movie.poster;
  const pct = progressPct(movie);
  const left = minutesLeft(movie);

  const chips = [
    `<button class="chip${!movie.folderId ? " is-on" : ""}" data-nav data-assign="">No folder</button>`,
    ...state.folders.map(
      (folder) =>
        `<button class="chip${movie.folderId === folder.id ? " is-on" : ""}" data-nav data-assign="${esc(folder.id)}">${esc(folder.name)}</button>`,
    ),
    `<button class="chip chip-new" data-nav id="d-new-folder">+ New folder</button>`,
  ].join("");

  const panel = openModal(`
    <div class="detail-hero" ${art ? `style="background-image:url('${esc(art)}')"` : ""}>
      ${X_BTN}
    </div>
    <div class="detail-body">
      <div class="detail-poster">${
        movie.poster
          ? `<img src="${esc(movie.poster)}" alt="" onerror="this.parentElement.innerHTML=''" />`
          : `<div class="detail-fallback">${esc(movie.title)}</div>`
      }</div>
      <div class="detail-info">
        <h2>${esc(movie.title)}</h2>
        <div class="detail-meta">
          ${movie.year ? `<span>${movie.year}</span><span class="dot"></span>` : ""}
          ${movie.rating ? `<span class="star">★ ${movie.rating}</span><span class="dot"></span>` : ""}
          <span>${movie.url ? "Stream link" : "No link yet"}</span>
          ${pct ? `<span class="dot"></span><span>${left} min left</span>` : ""}
        </div>
        <p class="detail-overview">${esc(movie.overview) || "No synopsis yet. Use “Fix artwork” to pick the right TMDB match."}</p>
        ${pct ? `<div class="detail-progress"><span style="width:${pct.toFixed(2)}%"></span></div>` : ""}
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn primary" data-nav id="d-play" ${movie.url ? "" : "disabled"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/></svg>
        ${pct ? `Resume · ${left} min left` : "Play"}
      </button>
      <button class="btn ghost" data-nav id="d-match">Fix artwork</button>
      <button class="btn danger" data-nav id="d-remove">Remove</button>
    </div>
    <div class="detail-link">
      <label for="d-url">Stream link</label>
      <div class="inline">
        <input id="d-url" data-nav value="${esc(movie.url || "")}" placeholder="https://example.com/movie.mp4" spellcheck="false" />
        <button class="btn ghost small" data-nav id="d-url-save">Save</button>
      </div>
    </div>
    <div class="detail-folders">
      <span class="flabel">Folder</span>
      <div class="chips">${chips}</div>
      <div class="folder-form" id="d-folder-form" hidden>
        <input id="d-folder-name" data-nav placeholder="New folder name" spellcheck="false" />
        <button class="btn primary small" data-nav id="d-folder-save">Add</button>
      </div>
    </div>
  `);

  $("#d-play", panel).onclick = () => {
    if (!movie.url) return toast("Paste a stream link below first.");
    closeModal();
    play(movie);
  };
  $("#d-match", panel).onclick = () => openMatch(movie);

  const saveUrl = () => {
    const value = $("#d-url", panel).value.trim();
    if (value && !/^https?:\/\//i.test(value)) return toast("Enter a full http(s) link.");
    movie.url = value || null;
    saveStore();
    render();
    openDetail(movie.id);
    toast(value ? "Stream link saved." : "Stream link cleared.");
  };
  $("#d-url-save", panel).onclick = saveUrl;
  $("#d-url", panel).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveUrl();
    }
  });

  const removeBtn = $("#d-remove", panel);
  let armed = false;
  removeBtn.onclick = () => {
    if (!armed) {
      armed = true;
      removeBtn.textContent = "Tap again to remove";
      return;
    }
    state.movies = state.movies.filter((m) => m.id !== movie.id);
    saveStore();
    closeModal();
    render();
    toast(`Removed “${movie.title}”.`);
  };

  $$("[data-assign]", panel).forEach((chip) => {
    chip.onclick = () => assignFolder(movie, chip.dataset.assign || null);
  });

  const form = $("#d-folder-form", panel);
  $("#d-new-folder", panel).onclick = () => {
    form.hidden = false;
    setFocus($("#d-folder-name", panel));
  };
  const createAndAssign = () => {
    const name = $("#d-folder-name", panel).value.trim();
    if (!name) return toast("Name the folder first.");
    const folder = { id: uid(), name, createdAt: new Date().toISOString() };
    state.folders.push(folder);
    assignFolder(movie, folder.id);
  };
  $("#d-folder-save", panel).onclick = createAndAssign;
  $("#d-folder-name", panel).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createAndAssign();
    }
  });

  focusModal();
}

/* ------------------------------------------------------- match / artwork */

async function openMatch(movie) {
  const panel = openModal(
    `
    <div class="modal-head">
      <div>
        <h2>Match artwork</h2>
        <p>Search TMDB for the right film, then pick it to replace the poster, backdrop and synopsis.</p>
      </div>
      ${X_BTN}
    </div>
    <div class="modal-body">
      <div class="field">
        <div class="inline">
          <input id="m-q" value="${esc(movie.title)}" data-nav spellcheck="false" />
          <button class="btn ghost small" data-nav id="m-go">Search</button>
        </div>
      </div>
      <div class="match-list" id="m-results"><div class="browser-empty">Searching…</div></div>
    </div>`,
    true,
  );

  const results = $("#m-results", panel);

  const run = async () => {
    results.innerHTML = `<div class="browser-empty">Searching…</div>`;
    try {
      const list = await tmdbSearch($("#m-q", panel).value.trim());
      if (!list.length) {
        results.innerHTML = `<div class="browser-empty">No TMDB matches. Try a shorter title.</div>`;
        return;
      }
      results.innerHTML = list
        .map(
          (hit) => `
          <button class="match-row" data-nav data-tmdb="${hit.tmdbId}">
            ${hit.poster ? `<img src="${esc(hit.poster)}" alt="" loading="lazy" />` : `<div style="width:42px;flex:none"></div>`}
            <div>
              <div class="m-title">${esc(hit.title)}</div>
              <div class="m-sub">${hit.year || "—"}${hit.rating ? ` · ★ ${hit.rating}` : ""}</div>
              ${hit.overview ? `<div class="m-ov">${esc(hit.overview)}</div>` : ""}
            </div>
          </button>`,
        )
        .join("");

      $$("[data-tmdb]", results).forEach((row) => {
        row.onclick = () => {
          const hit = list.find((item) => String(item.tmdbId) === row.dataset.tmdb);
          if (!hit) return;
          movie.title = hit.title;
          movie.year = hit.year;
          movie.overview = hit.overview;
          movie.poster = hit.poster;
          movie.backdrop = hit.backdrop;
          movie.rating = hit.rating;
          movie.tmdbId = hit.tmdbId;
          saveStore();
          closeModal();
          render();
          openDetail(movie.id);
          toast("Artwork updated.");
        };
      });
    } catch (err) {
      results.innerHTML = `<div class="browser-empty">${esc(err.message)}</div>`;
    }
  };

  $("#m-go", panel).onclick = run;
  $("#m-q", panel).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      run();
    }
  });
  run();
  focusModal();
}

/* ------------------------------------------------------------ interactions */

document.addEventListener("click", (event) => {
  const playBtn = event.target.closest("[data-play]");
  if (playBtn) {
    const movie = state.movies.find((m) => m.id === playBtn.dataset.play);
    if (movie) play(movie);
    return;
  }
  const detailBtn = event.target.closest("[data-detail]");
  if (detailBtn) {
    openDetail(detailBtn.dataset.detail);
    return;
  }
  const card = event.target.closest(".card");
  if (card) openDetail(card.dataset.id);
});

$("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

$("#btn-add").onclick = () => openAddModal("link");
$("#btn-settings").onclick = openSettings;
$("#notice-action").onclick = openSettings;
$("#empty-add").onclick = () => openAddModal("link");
$("#empty-settings").onclick = openSettings;
$("#player-close").onclick = closePlayer;

videoEl.addEventListener("click", () => {
  $("#player").classList.toggle("show-bar");
});

/* --------------------------------------------------------- key handling */

const NAV_KEYS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  a: "left",
  d: "right",
  w: "up",
  s: "down",
};

document.addEventListener("keydown", (event) => {
  const typing = ["input", "textarea", "select"].includes(event.target.tagName?.toLowerCase());
  const playerOpen = !$("#player").hidden;

  if (event.key === "Escape") {
    if (typing) {
      event.target.blur();
      return;
    }
    back();
    return;
  }

  if (playerOpen) {
    if (event.key === " " || event.key === "Enter" || event.key === "k") {
      event.preventDefault();
      if (videoEl.paused) videoEl.play().catch(() => {});
      else videoEl.pause();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
      saveProgress();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + 10);
      saveProgress();
      return;
    }
    if (event.key === "f") videoEl.requestFullscreen?.();
    return;
  }

  if (typing) return;

  const dir = NAV_KEYS[event.key];
  if (dir) {
    event.preventDefault();
    moveFocus(dir);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    if (document.activeElement?.tagName === "VIDEO") return;
    event.preventDefault();
    activateFocused();
  }
});

/* ------------------------------------------------------------- gamepad */

const padHold = { dir: null, nextAt: 0 };
let padButtonState = { a: false, b: false };

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let dir = null;
  let a = false;
  let b = false;

  for (const pad of pads) {
    if (!pad) continue;
    const pressed = (i) => Boolean(pad.buttons[i]?.pressed);
    if (pressed(12)) dir = "up";
    else if (pressed(13)) dir = "down";
    else if (pressed(14)) dir = "left";
    else if (pressed(15)) dir = "right";
    else {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.abs(ax) > 0.55 && Math.abs(ax) > Math.abs(ay)) dir = ax > 0 ? "right" : "left";
      else if (Math.abs(ay) > 0.55) dir = ay > 0 ? "down" : "up";
    }
    a = a || pressed(0) || pressed(9);
    b = b || pressed(1);
  }

  const now = performance.now();
  if (dir) {
    if (padHold.dir !== dir) {
      padHold.dir = dir;
      padHold.nextAt = now + 400;
      moveFocus(dir);
    } else if (now > padHold.nextAt) {
      padHold.nextAt = now + 130;
      moveFocus(dir);
    }
  } else {
    padHold.dir = null;
  }

  if (a && !padButtonState.a) activateFocused();
  if (b && !padButtonState.b) back();
  padButtonState = { a, b };

  requestAnimationFrame(pollGamepad);
}

if (typeof navigator.getGamepads === "function") requestAnimationFrame(pollGamepad);
window.addEventListener("gamepadconnected", () =>
  toast("Controller connected — arrows to move, A to select, B to go back", 5000),
);

/* ------------------------------------------------------------------ boot */

loadStore();
render();
const firstControl = $(".hero [data-nav]") || $(".card[data-nav]") || $("[data-nav]");
if (firstControl) setFocus(firstControl, false);
