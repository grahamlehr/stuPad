export type ExportOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Gets a File off the iPad per SPEC "Exit and reporting": prefer the iOS
 * share sheet (Web Share API with files) for Save to Files / AirDrop / Mail;
 * plain browser downloads are a fallback only, since they're unreliable in
 * Home Screen web apps.
 */
export async function exportFile(file: File): Promise<ExportOutcome> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const canShareFiles =
    nav && typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] });

  if (canShareFiles) {
    try {
      await nav!.share({ files: [file], title: file.name });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // any other share failure falls through to the download fallback
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // give the browser a tick to pick up the download before revoking
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return 'downloaded';
}
