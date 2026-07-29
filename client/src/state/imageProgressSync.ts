export interface ImageProgressValue {
  value?: number;
  max?: number;
  preview?: string;
}

export type ImageProgressState = Record<number, ImageProgressValue>;

/**
 * Accept progress only while the referenced message still exists and is
 * rendering. Repeated Comfy events are common; returning the existing object
 * for an identical value also prevents duplicate reactive updates.
 */
export function applyImageProgress(
  progress: ImageProgressState,
  messages: Readonly<Record<number, { imagePending: boolean } | undefined>>,
  mid: number,
  update: ImageProgressValue,
): ImageProgressState {
  if (!messages[mid]?.imagePending) return progress;
  const current = progress[mid];
  if (
    current?.value === (update.value ?? current?.value) &&
    current?.max === (update.max ?? current?.max) &&
    current?.preview === (update.preview ?? current?.preview)
  ) {
    return progress;
  }
  return { ...progress, [mid]: { ...current, ...update } };
}

/** Drop progress belonging to completed or deleted messages after a tree frame. */
export function retainPendingImageProgress(
  progress: ImageProgressState,
  messages: Readonly<Record<number, { imagePending: boolean } | undefined>>,
): ImageProgressState {
  const stale = Object.keys(progress).some((mid) => !messages[Number(mid)]?.imagePending);
  if (!stale) return progress;
  return Object.fromEntries(
    Object.entries(progress).filter(([mid]) => messages[Number(mid)]?.imagePending),
  );
}
