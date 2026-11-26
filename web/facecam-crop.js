(() => {
  const DEFAULT_RECT = { x: 0.62, y: 0.04, w: 0.34, h: 0.19 };
  const MIN_W = 0.12;
  const MIN_H = 0.08;
  const DEFAULT_SPLIT_RATIO = 0.4;
  const MIN_SPLIT_RATIO = 0.25;
  const MAX_SPLIT_RATIO = 0.6;
  const OUT_W = 1080;
  const OUT_H = 1920;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ...DEFAULT_RECT };
    }
    let x = Number(raw.x);
    let y = Number(raw.y);
    let w = Number(raw.w);
    let h = Number(raw.h);
    if (![x, y, w, h].every(Number.isFinite)) {
      return { ...DEFAULT_RECT };
    }
    if (w > 1 || h > 1 || x > 1 || y > 1) {
      x /= 100;
      y /= 100;
      w /= 100;
      h /= 100;
    }
    w = clamp(w, MIN_W, 1);
    h = clamp(h, MIN_H, 1);
    x = clamp(x, 0, Math.max(0, 1 - w));
    y = clamp(y, 0, Math.max(0, 1 - h));
    return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
  }

  function moveRect(rect, dx, dy) {
    const base = normalize(rect);
    return {
      x: round4(clamp(base.x + dx, 0, Math.max(0, 1 - base.w))),
      y: round4(clamp(base.y + dy, 0, Math.max(0, 1 - base.h))),
      w: base.w,
      h: base.h,
    };
  }

  function resizeRect(rect, corner, dx, dy) {
    const base = normalize(rect);
    let left = base.x;
    let top = base.y;
    let right = base.x + base.w;
    let bottom = base.y + base.h;

    if (corner === "nw" || corner === "sw") {
      left = clamp(base.x + dx, 0, right - MIN_W);
    } else {
      right = clamp(base.x + base.w + dx, left + MIN_W, 1);
    }

    if (corner === "nw" || corner === "ne") {
      top = clamp(base.y + dy, 0, bottom - MIN_H);
    } else {
      bottom = clamp(base.y + base.h + dy, top + MIN_H, 1);
    }

    return {
      x: round4(left),
      y: round4(top),
      w: round4(right - left),
      h: round4(bottom - top),
    };
  }

  function toPct(rect) {
    const r = normalize(rect);
    return {
      x: Math.round(r.x * 1000) / 10,
      y: Math.round(r.y * 1000) / 10,
      w: Math.round(r.w * 1000) / 10,
      h: Math.round(r.h * 1000) / 10,
    };
  }

  function toPx(rect) {
    const r = normalize(rect);
    const w = Math.max(80, Math.round((r.w * OUT_W) / 2) * 2);
    const h = Math.max(80, Math.round((r.h * OUT_H) / 2) * 2);
    const x = clamp(Math.round(r.x * OUT_W), 0, Math.max(0, OUT_W - w));
    const y = clamp(Math.round(r.y * OUT_H), 0, Math.max(0, OUT_H - h));
    return { x, y, w, h };
  }

  function normalizeSplit(raw) {
    if (raw === null || raw === undefined || raw === "") return DEFAULT_SPLIT_RATIO;
    let v = Number(raw);
    if (!Number.isFinite(v)) return DEFAULT_SPLIT_RATIO;
    if (v > 1) v /= 100;
    return round4(clamp(v, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO));
  }

  function splitToPct(raw) {
    const r = normalizeSplit(raw);
    const top = Math.round(r * 100);
    return { top, bottom: 100 - top };
  }

  function splitToPx(raw) {
    const r = normalizeSplit(raw);
    const minH = Math.round((MIN_SPLIT_RATIO * OUT_H) / 2) * 2;
    const maxH = Math.round((MAX_SPLIT_RATIO * OUT_H) / 2) * 2;
    const topH = clamp(Math.round((r * OUT_H) / 2) * 2, minH, maxH);
    return { topH, bottomH: OUT_H - topH };
  }

  function computeMediaBounds(stageEl, mediaEl) {
    const sr = stageEl.getBoundingClientRect();
    if (!mediaEl) {
      return { left: 0, top: 0, width: sr.width, height: sr.height };
    }
    const mr = mediaEl.getBoundingClientRect();
    const boxW = mr.width || sr.width;
    const boxH = mr.height || sr.height;
    const natW = mediaEl.videoWidth || mediaEl.naturalWidth || 9;
    const natH = mediaEl.videoHeight || mediaEl.naturalHeight || 16;
    const natAspect = natW / Math.max(1, natH);
    const boxAspect = boxW / Math.max(1, boxH);

    let drawW = boxW;
    let drawH = boxH;
    let offX = 0;
    let offY = 0;
    if (boxAspect > natAspect) {
      drawH = boxH;
      drawW = boxH * natAspect;
      offX = (boxW - drawW) / 2;
    } else {
      drawW = boxW;
      drawH = boxW / natAspect;
      offY = (boxH - drawH) / 2;
    }
    return {
      left: mr.left - sr.left + offX,
      top: mr.top - sr.top + offY,
      width: Math.max(1, drawW),
      height: Math.max(1, drawH),
    };
  }

  const CORNER_META = [
    { key: "nw", label: "Resize facecam top-left corner" },
    { key: "ne", label: "Resize facecam top-right corner" },
    { key: "sw", label: "Resize facecam bottom-left corner" },
    { key: "se", label: "Resize facecam bottom-right corner" },
  ];

  function mountStageFacecam(opts) {
    const stageEl = opts.stage;
    if (!stageEl) return null;

    // Remove any stale overlay previously mounted on this stage
    stageEl.querySelector(".fc-frame")?.remove();

    let rect = normalize(opts.rect);
    let splitRatio = normalizeSplit(opts.splitRatio);
    let mode = opts.mode === "split" ? "split" : "movable";
    let visible = opts.visible !== false;
    const compact = Boolean(opts.compact);
    const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
    const onCommit = typeof opts.onCommit === "function" ? opts.onCommit : () => {};
    const onSplitChange = typeof opts.onSplitChange === "function" ? opts.onSplitChange : () => {};
    const onSplitCommit = typeof opts.onSplitCommit === "function" ? opts.onSplitCommit : () => {};

    const frame = document.createElement("div");
    frame.className = "fc-frame" + (compact ? " compact" : "");
    frame.setAttribute("data-testid", compact ? "creator-facecam-frame" : "stage-facecam-frame");
    frame.dataset.mode = mode;
    frame.hidden = !visible;

    const guides = document.createElement("div");
    guides.className = "fc-guides";
    guides.setAttribute("aria-hidden", "true");
    guides.innerHTML = `<i class="fc-gx"></i><i class="fc-gy"></i>`;
    frame.appendChild(guides);

    const box = document.createElement("div");
    box.className = "fc-box";
    box.setAttribute("role", "group");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-label", "Facecam crop region — drag to move, arrow keys to nudge");
    box.setAttribute("data-testid", compact ? "creator-facecam-box" : "stage-facecam-box");

    const tag = document.createElement("span");
    tag.className = "fc-tag";
    tag.textContent = "Facecam";
    box.appendChild(tag);

    const dim = document.createElement("span");
    dim.className = "fc-dim";
    box.appendChild(dim);

    const handles = {};
    for (const c of CORNER_META) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `fc-handle fc-${c.key}`;
      btn.dataset.corner = c.key;
      btn.setAttribute("aria-label", c.label);
      btn.setAttribute("data-testid", `${compact ? "creator-" : ""}facecam-handle-${c.key}`);
      box.appendChild(btn);
      handles[c.key] = btn;
    }

    frame.appendChild(box);

    // Splitscreen overlay (top Facecam pane + draggable horizontal divider + bottom Gameplay pane)
    const splitEl = document.createElement("div");
    splitEl.className = "fc-split";
    splitEl.setAttribute("data-testid", compact ? "creator-split-overlay" : "stage-split-overlay");

    const splitTop = document.createElement("div");
    splitTop.className = "fc-split-top";
    const splitTopTag = document.createElement("span");
    splitTopTag.className = "fc-split-lbl";
    splitTop.appendChild(splitTopTag);

    const splitBar = document.createElement("button");
    splitBar.type = "button";
    splitBar.className = "fc-split-bar";
    splitBar.setAttribute("role", "slider");
    splitBar.setAttribute("aria-orientation", "vertical");
    splitBar.setAttribute("aria-valuemin", String(Math.round(MIN_SPLIT_RATIO * 100)));
    splitBar.setAttribute("aria-valuemax", String(Math.round(MAX_SPLIT_RATIO * 100)));
    splitBar.setAttribute("aria-label", "Adjust splitscreen facecam height");
    splitBar.setAttribute("data-testid", compact ? "creator-split-divider" : "stage-split-divider");
    splitBar.innerHTML = `<span class="fc-split-grip" aria-hidden="true"></span>`;

    const splitBot = document.createElement("div");
    splitBot.className = "fc-split-bot";
    const splitBotTag = document.createElement("span");
    splitBotTag.className = "fc-split-lbl";
    splitBot.appendChild(splitBotTag);

    splitEl.appendChild(splitTop);
    splitEl.appendChild(splitBar);
    splitEl.appendChild(splitBot);
    frame.appendChild(splitEl);

    stageEl.appendChild(frame);

    function syncFrameBounds() {
      const mediaEl = stageEl.querySelector("video, img");
      const b = computeMediaBounds(stageEl, mediaEl);
      frame.style.left = `${b.left}px`;
      frame.style.top = `${b.top}px`;
      frame.style.width = `${b.width}px`;
      frame.style.height = `${b.height}px`;
    }

    function applyModeVisibility() {
      frame.dataset.mode = mode;
      box.hidden = mode !== "movable";
      splitEl.hidden = mode !== "split";
    }

    function applySplitStyles() {
      const pct = splitToPct(splitRatio);
      splitTop.style.height = `${(splitRatio * 100).toFixed(2)}%`;
      splitBar.style.top = `${(splitRatio * 100).toFixed(2)}%`;
      splitBot.style.top = `${(splitRatio * 100).toFixed(2)}%`;
      splitBar.setAttribute("aria-valuenow", String(pct.top));
      splitBar.setAttribute("aria-valuetext", `Facecam ${pct.top}%, Gameplay ${pct.bottom}%`);
      splitTopTag.textContent = compact ? `CAM ${pct.top}%` : `FACECAM · ${pct.top}%`;
      splitBotTag.textContent = compact ? `GAME ${pct.bottom}%` : `GAMEPLAY · ${pct.bottom}%`;
    }

    function applyRectStyles() {
      box.style.left = `${(rect.x * 100).toFixed(2)}%`;
      box.style.top = `${(rect.y * 100).toFixed(2)}%`;
      box.style.width = `${(rect.w * 100).toFixed(2)}%`;
      box.style.height = `${(rect.h * 100).toFixed(2)}%`;
      const p = toPct(rect);
      dim.textContent = compact
        ? `${Math.round(p.w)}×${Math.round(p.h)}%`
        : `${Math.round(p.x)}%, ${Math.round(p.y)}% · ${Math.round(p.w)}×${Math.round(p.h)}%`;
      // Keep badge readable when box sits near top edge
      box.classList.toggle("near-top", rect.y < 0.08);
      box.classList.toggle("near-bottom", rect.y + rect.h > 0.88);
    }

    let dragState = null;

    function startDrag(e, mode, corner) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      syncFrameBounds();
      const fr = frame.getBoundingClientRect();
      if (fr.width <= 0 || fr.height <= 0) return;

      dragState = {
        mode,
        corner: corner || null,
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...rect },
        originSplit: splitRatio,
        frameW: fr.width,
        frameH: fr.height,
        moved: false,
        pointerId: e.pointerId,
        target: e.currentTarget,
      };
      frame.classList.add("dragging");
      if (mode === "split") splitBar.classList.add("active");
      else box.classList.add("active");
      try {
        if (e.pointerId != null && e.currentTarget.setPointerCapture) {
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      } catch {}

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerEnd);
      window.addEventListener("pointercancel", onPointerEnd);
    }

    function onPointerMove(e) {
      if (!dragState) return;
      const dxPx = e.clientX - dragState.startX;
      const dyPx = e.clientY - dragState.startY;
      if (Math.abs(dxPx) > 0.5 || Math.abs(dyPx) > 0.5) {
        dragState.moved = true;
      }
      if (dragState.mode === "split") {
        const dy = dyPx / dragState.frameH;
        splitRatio = normalizeSplit(dragState.originSplit + dy);
        applySplitStyles();
        onSplitChange(splitRatio);
        return;
      }
      const dx = dxPx / dragState.frameW;
      const dy = dyPx / dragState.frameH;
      const next =
        dragState.mode === "move"
          ? moveRect(dragState.origin, dx, dy)
          : resizeRect(dragState.origin, dragState.corner, dx, dy);
      rect = next;
      applyRectStyles();
      onChange({ ...rect });
    }

    function onPointerEnd() {
      if (!dragState) return;
      const wasMoved = dragState.moved;
      const dragMode = dragState.mode;
      const target = dragState.target;
      const pid = dragState.pointerId;
      dragState = null;
      frame.classList.remove("dragging");
      box.classList.remove("active");
      splitBar.classList.remove("active");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      try {
        if (pid != null && target?.releasePointerCapture) {
          target.releasePointerCapture(pid);
        }
      } catch {}
      if (wasMoved) {
        if (dragMode === "split") onSplitCommit(splitRatio);
        else onCommit({ ...rect });
      }
    }

    splitBar.addEventListener("pointerdown", (e) => {
      startDrag(e, "split", null);
    });
    splitBar.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      let dy = 0;
      if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      splitRatio = normalizeSplit(splitRatio + dy);
      applySplitStyles();
      onSplitChange(splitRatio);
      onSplitCommit(splitRatio);
    });

    box.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".fc-handle")) return;
      startDrag(e, "move", null);
    });

    for (const c of CORNER_META) {
      handles[c.key].addEventListener("pointerdown", (e) => {
        startDrag(e, "resize", c.key);
      });
      handles[c.key].addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowLeft") dx = -step;
        else if (e.key === "ArrowRight") dx = step;
        else if (e.key === "ArrowUp") dy = -step;
        else if (e.key === "ArrowDown") dy = step;
        else return;
        e.preventDefault();
        e.stopPropagation();
        rect = resizeRect(rect, c.key, dx, dy);
        applyRectStyles();
        onChange({ ...rect });
        onCommit({ ...rect });
      });
    }

    box.addEventListener("keydown", (e) => {
      if (e.target !== box) return;
      const step = e.shiftKey ? 0.05 : 0.01;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      e.preventDefault();
      rect = moveRect(rect, dx, dy);
      applyRectStyles();
      onChange({ ...rect });
      onCommit({ ...rect });
    });

    const mediaEl = stageEl.querySelector("video, img");
    const onMeta = () => syncFrameBounds();
    if (mediaEl) {
      mediaEl.addEventListener("loadedmetadata", onMeta);
      mediaEl.addEventListener("load", onMeta);
    }

    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => syncFrameBounds());
      ro.observe(stageEl);
      if (mediaEl) ro.observe(mediaEl);
    }
    window.addEventListener("resize", onMeta);

    syncFrameBounds();
    applyModeVisibility();
    applyRectStyles();
    applySplitStyles();
    requestAnimationFrame(syncFrameBounds);

    return {
      getRect() {
        return { ...rect };
      },
      setRect(next) {
        rect = normalize(next);
        applyRectStyles();
      },
      getSplitRatio() {
        return splitRatio;
      },
      setSplitRatio(next) {
        splitRatio = normalizeSplit(next);
        applySplitStyles();
      },
      getMode() {
        return mode;
      },
      setMode(nextMode) {
        mode = nextMode === "split" ? "split" : "movable";
        applyModeVisibility();
        if (visible) syncFrameBounds();
      },
      setVisible(on) {
        visible = Boolean(on);
        frame.hidden = !visible;
        if (visible) syncFrameBounds();
      },
      isVisible() {
        return visible;
      },
      syncBounds: syncFrameBounds,
      destroy() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerEnd);
        window.removeEventListener("pointercancel", onPointerEnd);
        window.removeEventListener("resize", onMeta);
        if (mediaEl) {
          mediaEl.removeEventListener("loadedmetadata", onMeta);
          mediaEl.removeEventListener("load", onMeta);
        }
        if (ro) ro.disconnect();
        frame.remove();
      },
    };
  }

  window.PeakCutFacecam = {
    DEFAULT_RECT,
    MIN_W,
    MIN_H,
    DEFAULT_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
    MAX_SPLIT_RATIO,
    normalize,
    moveRect,
    resizeRect,
    toPct,
    toPx,
    normalizeSplit,
    splitToPct,
    splitToPx,
    mountStageFacecam,
  };
})();
