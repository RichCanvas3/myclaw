/** Best-effort extract Telegram Bot API file_id for vision / weight_analyze_meal_photo (largest photo when sizes array). */

/** True when the string is clearly not a Bot API file_id (LLM placeholder, too short, etc.). */
export function telegramFileIdLooksPlaceholder(fileId: string): boolean {
  const s = fileId.trim();
  if (!s) return true;
  // Real photo file_ids are typically long; short English-like tokens are almost always hallucinations.
  if (s.length < 20) return true;
  if (/^(image|file|photo)[_.-]?(file[_.-]?)?id[s]?$/i.test(s)) return true;
  if (/^file_?id$/i.test(s)) return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function extractTelegramMessagePhotoFileId(m: Record<string, unknown>): string | null {
  const pickLastFileId = (arr: unknown): string | null => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const last = arr[arr.length - 1];
    if (!isRecord(last)) return null;
    const id = (last.fileId ?? last.file_id) as unknown;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  };
  const fromPhotos = pickLastFileId(m.photos);
  if (fromPhotos) return fromPhotos;
  const fromPhoto = pickLastFileId(m.photo);
  if (fromPhoto) return fromPhoto;
  const img = m.image;
  if (isRecord(img)) {
    const id = (img.fileId ?? img.file_id) as unknown;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  const doc = m.document;
  if (isRecord(doc)) {
    const id = doc.fileId ?? doc.file_id;
    if (typeof id === "string" && id.trim()) return id.trim();
    if (isRecord(id) && typeof id.file_id === "string") return id.file_id;
  }
  return null;
}
