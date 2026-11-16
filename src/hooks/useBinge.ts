import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 连播态(binge)状态机。
 * 显式两态 feed|binge，替代原来散落的 binge boolean + bingeRef。
 * 转移：
 *   feed  --enter-->        binge   （点「看完整剧」）
 *   binge --exit-->         feed    （返回键 / 退出按钮 / 下滑）
 *   binge --finish-->       feed    （连播到末集自动播完，触发 onFinish）
 * modeRef 同步写入供 onScroll/go 等非 React 回调零延迟读取，避免闭包旧值误换剧。
 */
export type BingeMode = "feed" | "binge";

export function useBinge(onFinish?: () => void) {
  const [mode, setModeState] = useState<BingeMode>("feed");
  /* ref 与 state 同 tick 写入，杜绝 enter/exit 当帧的闭包旧值 */
  const modeRef = useRef<BingeMode>("feed");

  const setMode = useCallback((m: BingeMode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  const enter = useCallback(() => setMode("binge"), [setMode]);
  const exit = useCallback(() => setMode("feed"), [setMode]);
  /** 连播到末集播完：回 feed 并通知外部（推荐下一部等） */
  const finish = useCallback(() => {
    setMode("feed");
    onFinish?.();
  }, [setMode, onFinish]);

  const isBinge = mode === "binge";

  /* 卸载时兜底复位，避免残留锁定态影响下一次进入 */
  useEffect(() => () => { modeRef.current = "feed"; }, []);

  return { mode, isBinge, modeRef, enter, exit, finish, setMode };
}
