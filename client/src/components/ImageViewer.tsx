import { onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';

/**
 * Fullscreen pan/zoom image viewer (interaction model borrowed from
 * SillyTavern's media modal): wheel zooms toward the cursor, pinch zooms
 * toward the touch midpoint, mouse or single-finger drag pans. Escape or a
 * backdrop click closes; double-click resets the view.
 */
export default function ImageViewer(props: { src: string; onClose: () => void }) {
  let overlay!: HTMLDivElement;
  let img!: HTMLImageElement;
  let scale = 1;
  let x = 0;
  let y = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let lastMidX = 0;
  let lastMidY = 0;

  const apply = () => {
    img.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
  };

  /** Zoom so the viewport point (cx, cy) stays fixed on the image. */
  const zoomAt = (cx: number, cy: number, next: number) => {
    const rect = img.getBoundingClientRect();
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    const clamped = Math.min(10, Math.max(0.1, next));
    const delta = clamped - scale;
    x -= (dx * delta) / scale;
    y -= (dy * delta) / scale;
    scale = clamped;
    apply();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * (e.deltaY > 0 ? 1 / 1.15 : 1.15));
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX - x;
    dragStartY = e.clientY - y;
    overlay.classList.add('dragging');
    e.preventDefault();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    x = e.clientX - dragStartX;
    y = e.clientY - dragStartY;
    apply();
  };
  const onMouseUp = () => {
    dragging = false;
    overlay.classList.remove('dragging');
  };

  const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midpoint = (a: Touch, b: Touch) => ({
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  });

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      pinching = true;
      dragging = false;
      pinchStartDist = distance(e.touches[0]!, e.touches[1]!);
      pinchStartScale = scale;
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      lastMidX = mid.x;
      lastMidY = mid.y;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      pinching = false;
      dragging = true;
      dragStartX = e.touches[0]!.clientX - x;
      dragStartY = e.touches[0]!.clientY - y;
    }
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      const mid = midpoint(e.touches[0]!, e.touches[1]!);
      // Pan by the midpoint travel, then zoom toward the midpoint.
      x += mid.x - lastMidX;
      y += mid.y - lastMidY;
      lastMidX = mid.x;
      lastMidY = mid.y;
      zoomAt(
        mid.x,
        mid.y,
        pinchStartScale * (distance(e.touches[0]!, e.touches[1]!) / pinchStartDist),
      );
    } else if (dragging && e.touches.length === 1) {
      e.preventDefault();
      x = e.touches[0]!.clientX - dragStartX;
      y = e.touches[0]!.clientY - dragStartY;
      apply();
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      // Pinch released into a single finger: continue as a pan from here.
      pinching = false;
      dragging = true;
      dragStartX = e.touches[0]!.clientX - x;
      dragStartY = e.touches[0]!.clientY - y;
    } else if (e.touches.length === 0) {
      pinching = false;
      dragging = false;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // Captured before ChatView's document listener: the chat must not swipe
    // siblings (and unmount this very message) underneath the viewer.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  };

  const reset = () => {
    scale = 1;
    x = 0;
    y = 0;
    apply();
  };

  onMount(() => {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  });

  return (
    <Portal>
      <div
        ref={overlay}
        class="image-viewer"
        onClick={(e) => {
          if (e.target === overlay) props.onClose();
        }}
        onDblClick={reset}
        onWheel={onWheel}
        // on: attaches directly to the element (not Solid's delegated document
        // listener, which is passive for touch events and ignores preventDefault).
        on:touchstart={onTouchStart}
        on:touchmove={onTouchMove}
        on:touchend={onTouchEnd}
        on:touchcancel={onTouchEnd}
      >
        <img ref={img} src={props.src} alt="" draggable={false} onMouseDown={onMouseDown} />
        <button class="icon-btn image-viewer-close" title="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
    </Portal>
  );
}
