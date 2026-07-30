import { For, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

interface ImageLayer {
  id: number;
  src: string;
  fade: boolean;
}

/**
 * Keeps the previous image underneath long enough for each new source to fade
 * in. This matters for ComfyUI previews, whose data URL changes every few
 * sampler steps; a transition on `img[src]` alone would still snap because the
 * browser replaces the pixels in the existing element.
 */
export default function CrossfadeImage(props: {
  src: string;
  alt: string;
  class?: string;
  classList?: Record<string, boolean | undefined>;
  wrapperClass?: string;
  onClick?: JSX.EventHandlerUnion<HTMLImageElement, MouseEvent>;
}) {
  const [layers, setLayers] = createSignal<ImageLayer[]>([]);
  let nextId = 0;
  const animations = new Map<number, Animation>();

  createEffect(() => {
    const src = props.src;
    const current = layers().at(-1);
    if (current?.src === src) return;

    const layer = { id: ++nextId, src, fade: current != null };
    // At most one underlay is useful. Dropping older previews also keeps the
    // large transient data URLs from accumulating during a long render.
    setLayers((existing) => [...existing.slice(-1), layer]);
  });

  const reveal = (layer: ImageLayer, image: HTMLImageElement) => {
    // A superseded preview may finish decoding after its replacement.
    if (layer.id !== currentId()) return;
    // The first image has no previous frame to cross-fade from. This is also
    // how existing image messages appear immediately on initial page load.
    if (!layer.fade) {
      image.style.opacity = '1';
      return;
    }

    // Web Animations drives the actual image element's alpha after decoding:
    // the new frame is already stacked above its predecessor at opacity 0,
    // then reaches 1 before the predecessor is removed.
    const animation = image.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      easing: 'ease-out',
      fill: 'forwards',
    });
    animations.set(layer.id, animation);
    void animation.finished
      .then(() => {
        image.style.opacity = '1';
        animation.cancel();
        animations.delete(layer.id);
        if (layer.id === currentId()) {
          setLayers((existing) => existing.filter((item) => item.id >= layer.id));
        }
      })
      .catch(() => {
        animations.delete(layer.id);
      });
  };

  onCleanup(() => {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  });

  const currentId = () => layers().at(-1)?.id;

  return (
    <span class={`image-crossfade ${props.wrapperClass ?? ''}`}>
      <For each={layers()}>
        {(layer) => {
          const current = () => layer.id === currentId();
          return (
            <img
              src={layer.src}
              alt={current() ? props.alt : ''}
              aria-hidden={!current()}
              class={props.class}
              // Later grid items naturally paint above earlier ones, so the
              // incoming frame needs no z-index. An ever-increasing value
              // would eventually cover the message header controls.
              style={{ opacity: layer.fade ? 0 : 1 }}
              classList={{
                ...(props.classList ?? {}),
                'image-crossfade-underlay': !current(),
              }}
              onClick={current() ? props.onClick : undefined}
              onLoad={(event) => reveal(layer, event.currentTarget)}
            />
          );
        }}
      </For>
    </span>
  );
}
