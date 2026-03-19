import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_CLICK_SCALE = 2.5;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

type Point = { x: number; y: number };
type Transform = { scale: number; x: number; y: number };

type PanGesture = {
  type: 'pan';
  startPoint: Point;
  startOffset: Point;
};

type PinchGesture = {
  type: 'pinch';
  startScale: number;
  startOffset: Point;
  startAnchor: Point;
  startDistance: number;
};

type GestureState = PanGesture | PinchGesture | null;

type WebKitGestureEvent = Event & {
  clientX: number;
  clientY: number;
  scale: number;
};

interface Props {
  alt: string;
  onClose: () => void;
  src: string;
}

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const getDistance = (first: Point, second: Point): number => {
  return Math.hypot(second.x - first.x, second.y - first.y);
};

export const ImageModalViewer: React.FC<Props> = ({ alt, onClose, src }) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<GestureState>(null);
  const transformRef = useRef<Transform>({ scale: MIN_SCALE, x: 0, y: 0 });
  const safariGestureRef = useRef<PinchGesture | null>(null);
  const [transform, setTransformState] = useState<Transform>({ scale: MIN_SCALE, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const getRelativePoint = useCallback((clientX: number, clientY: number): Point | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;

    const rect = viewport.getBoundingClientRect();
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }, []);

  const getPanLimits = useCallback((scale: number): Point => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) {
      return { x: 0, y: 0 };
    }

    const scaledWidth = image.clientWidth * scale;
    const scaledHeight = image.clientHeight * scale;

    return {
      x: Math.max(0, (scaledWidth - viewport.clientWidth) / 2),
      y: Math.max(0, (scaledHeight - viewport.clientHeight) / 2),
    };
  }, []);

  const commitTransform = useCallback((nextTransform: Transform | ((current: Transform) => Transform)) => {
    setTransformState((current) => {
      const resolved = typeof nextTransform === 'function' ? nextTransform(current) : nextTransform;
      const scale = clamp(resolved.scale, MIN_SCALE, MAX_SCALE);

      let x = resolved.x;
      let y = resolved.y;
      if (scale <= MIN_SCALE) {
        x = 0;
        y = 0;
      } else {
        const limits = getPanLimits(scale);
        x = clamp(x, -limits.x, limits.x);
        y = clamp(y, -limits.y, limits.y);
      }

      const finalTransform = { scale, x, y };
      transformRef.current = finalTransform;
      return finalTransform;
    });
  }, [getPanLimits]);

  const zoomAroundPoint = useCallback((nextScale: number, anchor: Point) => {
    commitTransform((current) => {
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (scale <= MIN_SCALE) {
        return { scale: MIN_SCALE, x: 0, y: 0 };
      }

      const scaleRatio = scale / current.scale;
      return {
        scale,
        x: anchor.x - (anchor.x - current.x) * scaleRatio,
        y: anchor.y - (anchor.y - current.y) * scaleRatio,
      };
    });
  }, [commitTransform]);

  const startPinchGesture = useCallback(() => {
    const [first, second] = Array.from(pointersRef.current.values());
    if (!first || !second) return;

    const anchor = getRelativePoint((first.x + second.x) / 2, (first.y + second.y) / 2);
    if (!anchor) return;

    gestureRef.current = {
      type: 'pinch',
      startScale: transformRef.current.scale,
      startOffset: { x: transformRef.current.x, y: transformRef.current.y },
      startAnchor: anchor,
      startDistance: Math.max(getDistance(first, second), 1),
    };
  }, [getRelativePoint]);

  const resetInteractionState = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    safariGestureRef.current = null;
    setIsDragging(false);
    commitTransform({ scale: MIN_SCALE, x: 0, y: 0 });
  }, [commitTransform]);

  useEffect(() => {
    resetInteractionState();
  }, [resetInteractionState, src]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as WebKitGestureEvent;
      const anchor = getRelativePoint(gestureEvent.clientX, gestureEvent.clientY);
      if (!anchor) return;

      event.preventDefault();
      safariGestureRef.current = {
        type: 'pinch',
        startScale: transformRef.current.scale,
        startOffset: { x: transformRef.current.x, y: transformRef.current.y },
        startAnchor: anchor,
        startDistance: 1,
      };
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as WebKitGestureEvent;
      const safariGesture = safariGestureRef.current;
      if (!safariGesture) return;

      const currentAnchor = getRelativePoint(gestureEvent.clientX, gestureEvent.clientY);
      if (!currentAnchor) return;

      event.preventDefault();
      const nextScale = clamp(safariGesture.startScale * gestureEvent.scale, MIN_SCALE, MAX_SCALE);
      const scaleRatio = nextScale / safariGesture.startScale;
      commitTransform({
        scale: nextScale,
        x: currentAnchor.x - (safariGesture.startAnchor.x - safariGesture.startOffset.x) * scaleRatio,
        y: currentAnchor.y - (safariGesture.startAnchor.y - safariGesture.startOffset.y) * scaleRatio,
      });
    };

    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      safariGestureRef.current = null;
    };

    viewport.addEventListener('gesturestart', handleGestureStart, { passive: false });
    viewport.addEventListener('gesturechange', handleGestureChange, { passive: false });
    viewport.addEventListener('gestureend', handleGestureEnd, { passive: false });

    return () => {
      viewport.removeEventListener('gesturestart', handleGestureStart);
      viewport.removeEventListener('gesturechange', handleGestureChange);
      viewport.removeEventListener('gestureend', handleGestureEnd);
    };
  }, [commitTransform, getRelativePoint]);

  useEffect(() => {
    const handleResize = () => {
      commitTransform((current) => current);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [commitTransform]);

  const finishPointerGesture = useCallback((pointerId: number, element: HTMLDivElement | null) => {
    if (element && 'hasPointerCapture' in element && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }

    pointersRef.current.delete(pointerId);

    if (pointersRef.current.size >= 2) {
      startPinchGesture();
      setIsDragging(false);
      return;
    }

    if (pointersRef.current.size === 1 && transformRef.current.scale > MIN_SCALE) {
      const [remainingPoint] = Array.from(pointersRef.current.values());
      if (remainingPoint) {
        gestureRef.current = {
          type: 'pan',
          startPoint: remainingPoint,
          startOffset: { x: transformRef.current.x, y: transformRef.current.y },
        };
      }
    } else {
      gestureRef.current = null;
    }

    setIsDragging(false);
  }, [startPinchGesture]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    event.preventDefault();
    if ('setPointerCapture' in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size >= 2) {
      startPinchGesture();
      setIsDragging(false);
      return;
    }

    if (transformRef.current.scale > MIN_SCALE) {
      gestureRef.current = {
        type: 'pan',
        startPoint: { x: event.clientX, y: event.clientY },
        startOffset: { x: transformRef.current.x, y: transformRef.current.y },
      };
      setIsDragging(true);
    }
  }, [startPinchGesture]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    event.preventDefault();

    if (gesture.type === 'pan' && pointersRef.current.size === 1) {
      commitTransform({
        scale: transformRef.current.scale,
        x: gesture.startOffset.x + (event.clientX - gesture.startPoint.x),
        y: gesture.startOffset.y + (event.clientY - gesture.startPoint.y),
      });
      setIsDragging(true);
      return;
    }

    if (gesture.type === 'pinch' && pointersRef.current.size >= 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      if (!first || !second) return;

      const currentAnchor = getRelativePoint((first.x + second.x) / 2, (first.y + second.y) / 2);
      if (!currentAnchor) return;

      const nextScale = clamp(
        gesture.startScale * (getDistance(first, second) / gesture.startDistance),
        MIN_SCALE,
        MAX_SCALE,
      );
      const scaleRatio = nextScale / gesture.startScale;

      commitTransform({
        scale: nextScale,
        x: currentAnchor.x - (gesture.startAnchor.x - gesture.startOffset.x) * scaleRatio,
        y: currentAnchor.y - (gesture.startAnchor.y - gesture.startOffset.y) * scaleRatio,
      });
      setIsDragging(false);
    }
  }, [commitTransform, getRelativePoint]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishPointerGesture(event.pointerId, event.currentTarget);
  }, [finishPointerGesture]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishPointerGesture(event.pointerId, event.currentTarget);
  }, [finishPointerGesture]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      const anchor = getRelativePoint(event.clientX, event.clientY);
      if (!anchor) return;

      event.preventDefault();
      const nextScale = transformRef.current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomAroundPoint(nextScale, anchor);
      return;
    }

    if (transformRef.current.scale > MIN_SCALE) {
      event.preventDefault();
      commitTransform((current) => ({
        scale: current.scale,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    }
  }, [commitTransform, getRelativePoint, zoomAroundPoint]);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = getRelativePoint(event.clientX, event.clientY);
    if (!anchor) return;

    const nextScale = transformRef.current.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_CLICK_SCALE;
    zoomAroundPoint(nextScale, anchor);
  }, [getRelativePoint, zoomAroundPoint]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 rounded-full bg-slate-900/70 px-3 py-1.5 text-sm text-white/85 hover:text-white hover:bg-slate-900 z-20"
        title="Close"
      >
        Close
      </button>
      <div
        ref={viewportRef}
        aria-label="Image viewer"
        className={`relative h-full w-full overflow-hidden ${transform.scale > MIN_SCALE ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'}`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      >
        <div className="flex h-full w-full items-center justify-center p-4">
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={() => commitTransform((current) => current)}
            className="pointer-events-none max-h-full max-w-full select-none will-change-transform"
            style={{
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              transformOrigin: 'center center',
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
};

