import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";

/**
 * Feed 手势系统（从 Feed.tsx 原样抽出，纯行为不变）：
 * - 双指捏合缩放 & 平移（pinch-to-zoom / pan）
 * - 长按 2x（上滑 64px 进入「松开即锁定」）
 * - 横拖定位（横向拖动 seek）
 * - 单击清屏 / 双击暂停
 * - 手势/缩放/全屏期间禁止外层列表原生滚动
 *
 * 内部持有 pinchRef/gesture/holdRef/lockArmedRef/scrubTarget/lastTapRef 六个 ref，
 * 对外只暴露事件处理器 + pinchRef/holdRef（onScroll、fs 复位、滚动锁定还要读）。
 */
export type Zoom = { scale: number; x: number; y: number; gesturing: boolean };
export type Scrub = { pct: number; target: number } | null;

type VideoHandle = {
  el: () => HTMLVideoElement | null;
  seek: (t: number, source: string) => void;
  toggle: () => void;
  play: () => void;
};

export function useFeedGestures(opts: {
  isDesktop: boolean;
  controlsLocked: boolean;
  active: boolean;
  rotated: boolean;
  fs: boolean;
  time: number;
  duration: number;
  playKey: string;
  videoIdsLength: number;
  zoom: Zoom;
  videoRef: MutableRefObject<VideoHandle | null>;
  boxRef: MutableRefObject<HTMLDivElement | null>;
  setZoom: (z: Zoom | ((prev: Zoom) => Zoom)) => void;
  setHoldSpeed: (v: boolean) => void;
  setSpeedLock: (v: boolean) => void;
  setLockArmed: (v: boolean) => void;
  setScrub: (s: Scrub) => void;
  setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  setErr: (v: string) => void;
  setTime: (v: number) => void;
  toast: (msg: string, icon?: "ok" | "heart" | "star" | "info") => void;
  /* 连播态垂直滑动切集：上滑=下一集(+1)，下滑=上一集(-1)；未传则垂直拖不切集 */
  onBingeSwipe?: (dir: 1 | -1) => void;
}) {
  const {
    isDesktop, controlsLocked, active, rotated, fs,
    time, duration, playKey, videoIdsLength,
    zoom, videoRef, boxRef,
    setZoom, setHoldSpeed, setSpeedLock, setLockArmed, setScrub, setClean, setErr, setTime,
    toast, onBingeSwipe,
  } = opts;

  /* —— 手势内部 ref（原来散在 Feed.tsx）—— */
  const pinchRef = useRef<{
    dist0: number; midX0: number; midY0: number; scale0: number; x0: number; y0: number;
  } | null>(null);
  const gesture = useRef<{
    x: number; y: number; startX: number; startY: number;
    t: number; base: number; width: number; playing: boolean;
    mode: "idle" | "hold" | "scrub" | "pan";
    timer: number;
  } | null>(null);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const scrubTarget = useRef<number | null>(null);
  /* 单击清屏 vs 双击暂停计时器 */
  const lastTapRef = useRef<{ time: number; timer: number | null }>({ time: 0, timer: null });
  const clearTapTimer = useCallback(() => {
    if (lastTapRef.current.timer) {
      window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
  }, []);

  const cancelSingleGesture = useCallback(() => {
    clearTapTimer();
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    if (holdRef.current) {
      holdRef.current = false;
      setHoldSpeed(false);
    }
    lockArmedRef.current = false;
    setLockArmed(false);
    setScrub(null);
    scrubTarget.current = null;
  }, [clearTapTimer, setHoldSpeed, setLockArmed, setScrub]);

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2) {
      cancelSingleGesture();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist0 = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX0 = (t0.clientX + t1.clientX) / 2;
      const midY0 = (t0.clientY + t1.clientY) / 2;
      pinchRef.current = {
        dist0, midX0, midY0,
        scale0: zoom.scale, x0: zoom.x, y0: zoom.y,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const p = pinchRef.current;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const nextScale = Math.max(0.85, Math.min(3.5, p.scale0 * (dist / p.dist0)));
      const rawDx = midX - p.midX0;
      const rawDy = midY - p.midY0;
      const dx = rotated ? rawDy : rawDx;
      const dy = rotated ? -rawDx : rawDy;
      const maxX = Math.max(0, (nextScale - 1) * window.innerWidth * 0.55);
      const maxY = Math.max(0, (nextScale - 1) * window.innerHeight * 0.55);
      const nextX = Math.max(-maxX, Math.min(maxX, p.x0 + dx));
      const nextY = Math.max(-maxY, Math.min(maxY, p.y0 + dy));
      setZoom({ scale: nextScale, x: nextX, y: nextY, gesturing: true });
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    if (pinchRef.current && e.touches.length < 2) {
      pinchRef.current = null;
      setZoom((prev) =>
        prev.scale < 1.08
          ? { scale: 1, x: 0, y: 0, gesturing: false }
          : { ...prev, gesturing: false },
      );
    }
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击清屏 / 双击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || !e.isPrimary || pinchRef.current || gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const span = rotated ? (el.clientHeight || window.innerHeight || 1) : (el.clientWidth || 1);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      t: Date.now(), base: time, width: span,
      playing: videoRef.current?.el()?.paused === false,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle" || pinchRef.current) return;
        clearTapTimer();
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      cancelSingleGesture();
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop || !e.isPrimary) return;
    const rawDx = e.clientX - g.x;
    const rawDy = e.clientY - g.y;
    const dx = rotated ? rawDy : rawDx;
    const dy = rotated ? -rawDx : rawDy;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const upDist = rotated ? (e.clientX - g.startX) : (g.startY - e.clientY);
      const armed = upDist > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
      } else if (Math.abs(dy) > 16) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "pan";
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total - 0.2, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = useCallback((e?: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (pinchRef.current) return;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      setScrub(null);
      scrubTarget.current = null;
      if (!cancelled && target != null) {
        setErr("");
        setTime(target);
        videoRef.current?.seek(target, "mobile_gesture");
      }
      if (g.playing && active) videoRef.current?.play();
      return;
    }

    /* 连播态垂直拖(pan)：上滑=下一集(+1)，下滑=上一集(-1)。阈值 56px，避免误触 */
    if (g.mode === "pan" && onBingeSwipe && !cancelled) {
      const totalDy = rotated ? (e?.clientX ?? g.x) - g.startX : g.startY - (e?.clientY ?? g.y);
      if (Math.abs(totalDy) >= 56) onBingeSwipe(totalDy > 0 ? 1 : -1);
      return;
    }

    if (cancelled || g.mode !== "idle") return;
    const moveDist = e ? Math.hypot(e.clientX - g.x, e.clientY - g.y) : 0;
    if (Date.now() - g.t < 260 && moveDist < 16) {
      const now = Date.now();
      if (now - lastTapRef.current.time < 280) {
        // 双击屏幕：切换暂停 / 播放
        clearTapTimer();
        lastTapRef.current.time = 0;
        videoRef.current?.toggle();
      } else {
        // 单击屏幕：切换清屏模式（消除或恢复所有界面控件，只显示视频内容）
        lastTapRef.current.time = now;
        clearTapTimer();
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
          setClean((c) => !c);
        }, 250) as unknown as number;
      }
    }
  }, [active, clearTapTimer, onBingeSwipe, setClean, setErr, setHoldSpeed, setLockArmed, setScrub, setSpeedLock, setTime, toast, videoRef]);

  /* 页面隐藏/控制锁定时取消未决手势 */
  useEffect(() => {
    if (!active || controlsLocked) onUp(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  /* 切换条目时清理手势计时器 */
  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  }, [playKey]);

  /* 长按倍速 / 双指缩放 / 全屏期间禁止外层列表原生滚动 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => {
      if (holdRef.current || pinchRef.current || fs || e.touches.length >= 2) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
  }, [isDesktop, videoIdsLength, fs, boxRef]);

  return {
    pinchRef,
    holdRef,
    gesture,
    clearTapTimer,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onDown,
    onMove,
    onUp,
  };
}
