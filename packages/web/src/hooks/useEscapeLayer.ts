import { useLayoutEffect, useRef, type RefObject } from 'react';
import { registerEscapeLayer, type EscapeLayer } from '../services/escape-stack';

export function useEscapeLayer(
  active: boolean,
  kind: EscapeLayer['kind'],
  close: EscapeLayer['close'],
  element?: RefObject<HTMLElement | null>,
): void {
  const latest = useRef(close);
  latest.current = close;
  useLayoutEffect(() => {
    if (!active) return;
    return registerEscapeLayer({ document, kind, close: () => latest.current(),
      ...(element ? { element: () => element.current } : {}) });
  }, [active, kind, element]);
}
