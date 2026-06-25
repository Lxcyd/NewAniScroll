import React, { useImperativeHandle, useRef } from "react";
import { ANIME_STICKER_MAP } from "@/lib/watch2gether/animeStickers";

// A contentEditable chat composer that can show emoji/sticker IMAGES inline in
// the input bar (a plain <input> can't). Anime stickers are inserted as
// <img data-shortcode=":x:">; on submit we serialize the DOM back to text,
// turning those images into their `:shortcode:` (which the chat renders as an
// image via ChatText). Unicode emoji are inserted as plain text characters.

export interface ChatComposerHandle {
  /** Insert a sticker image (by shortcode) or a unicode char at the caret. */
  insert: (token: string) => void;
  focus: () => void;
  /** Read the current value as serialized text. */
  getText: () => string;
  /** Clear the composer. */
  clear: () => void;
}

interface Props {
  placeholder: string;
  /** Fired on Enter (without Shift). Receives the serialized text. */
  onSubmit: (text: string) => void;
  /** Fired on any input/change with the serialized text (for hasText state etc). */
  onChange?: (text: string) => void;
  onFocus?: () => void;
  maxLen?: number;
  /** Extra styles merged onto the editable box. */
  style?: React.CSSProperties;
  className?: string;
}

// Serialize the editable DOM to message text: text nodes verbatim, sticker
// <img> → its `:shortcode:`, <br>/block boundaries → newline.
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "IMG") {
      out += el.getAttribute("data-shortcode") || el.getAttribute("alt") || "";
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    el.childNodes.forEach(walk);
    // A DIV/P boundary inside contentEditable represents a line break.
    if ((el.tagName === "DIV" || el.tagName === "P") && el.nextSibling) out += "\n";
  };
  root.childNodes.forEach(walk);
  return out.replace(/ /g, " ").trim();
}

const ChatComposer = React.forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  { placeholder, onSubmit, onChange, onFocus, maxLen = 500, style, className },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  const emitChange = () => onChange?.(boxRef.current ? serialize(boxRef.current) : "");

  // Insert a node at the current caret (or append if the caret is elsewhere).
  const insertNode = (node: Node) => {
    const box = boxRef.current;
    if (!box) return;
    box.focus();
    const sel = window.getSelection();
    if (!sel) return;
    // Ensure the caret is inside the box; if not, move it to the end.
    if (sel.rangeCount === 0 || !box.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(box);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    // Move caret right after the inserted node.
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    emitChange();
  };

  useImperativeHandle(ref, () => ({
    insert: (token: string) => {
      const sticker = ANIME_STICKER_MAP[token];
      if (sticker) {
        const img = document.createElement("img");
        img.src = sticker.src;
        img.alt = sticker.label;
        img.title = sticker.label;
        img.setAttribute("data-shortcode", sticker.shortcode);
        img.style.width = "22px";
        img.style.height = "22px";
        img.style.verticalAlign = "text-bottom";
        img.style.display = "inline-block";
        img.style.margin = "0 1px";
        insertNode(img);
      } else {
        // Unicode emoji (or any plain text) → text node.
        insertNode(document.createTextNode(token));
      }
    },
    focus: () => boxRef.current?.focus(),
    getText: () => (boxRef.current ? serialize(boxRef.current) : ""),
    clear: () => {
      if (boxRef.current) boxRef.current.innerHTML = "";
      emitChange();
    },
  }));

  const submit = () => {
    const box = boxRef.current;
    if (!box) return;
    const text = serialize(box);
    if (!text.trim()) return;
    onSubmit(text);
    box.innerHTML = "";
    emitChange();
  };

  return (
    <div
      ref={boxRef}
      role="textbox"
      aria-label={placeholder}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      className={`w2g-composer ${className || ""}`}
      onInput={() => {
        const box = boxRef.current;
        if (!box) return;
        let text = serialize(box);
        // Rough max-length guard (only trims on the rare over-cap path, e.g. a
        // big paste): drop whole trailing nodes until back under the cap.
        if (maxLen && text.length > maxLen) {
          while (text.length > maxLen && box.lastChild) {
            const last = box.lastChild;
            if (last.nodeType === Node.TEXT_NODE && (last.textContent?.length || 0) > 1) {
              last.textContent = last.textContent!.slice(0, maxLen - text.length);
            } else {
              box.removeChild(last);
            }
            text = serialize(box);
          }
        }
        onChange?.(text);
      }}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
      }}
      onPaste={(e) => {
        // Paste as PLAIN TEXT only (no foreign HTML/styles into the editable).
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      }}
      style={style}
    />
  );
});

export default ChatComposer;
