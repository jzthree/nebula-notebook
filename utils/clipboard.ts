/**
 * Copy text to the system clipboard with a legacy fallback.
 *
 * navigator.clipboard only exists in secure contexts (https or localhost).
 * Nebula is often served over plain http from a remote host (e.g. an HPC
 * login node), where it is undefined — fall back to the hidden-textarea
 * execCommand path there.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
