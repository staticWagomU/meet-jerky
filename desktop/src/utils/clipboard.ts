function restoreSelection(selection: Selection | null, ranges: Range[]) {
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  for (const range of ranges) {
    selection.addRange(range);
  }
}

function writeClipboardTextWithFallback(text: string, cause?: unknown) {
  if (typeof document === "undefined" || !document.body) {
    throw cause instanceof Error
      ? cause
      : new Error("Clipboard API is not available.");
  }

  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      ranges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  let didCopy = false;
  try {
    didCopy =
      typeof document.execCommand === "function" &&
      document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
    restoreSelection(selection, ranges);
  }

  if (!didCopy) {
    throw cause instanceof Error
      ? cause
      : new Error("Clipboard fallback failed.");
  }
}

export async function writeClipboardText(text: string) {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (e) {
      writeClipboardTextWithFallback(text, e);
      return;
    }
  }

  writeClipboardTextWithFallback(text);
}
