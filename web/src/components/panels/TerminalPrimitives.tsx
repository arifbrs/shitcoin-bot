import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { finite, numericTone } from "@/lib/terminal";
import type { PanelState, TokenView } from "@/lib/terminal";

export function LiveNumber({ value, children, width = 8, signed = false }: { value: number | null; children: ReactNode; width?: number; signed?: boolean }) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef<number | null>(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (finite(value) === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const node = element.current;
    node?.classList.remove("terminal-number-flash");
    const frame = requestAnimationFrame(() => node?.classList.add("terminal-number-flash"));
    const timer = window.setTimeout(() => node?.classList.remove("terminal-number-flash"), 400);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); node?.classList.remove("terminal-number-flash"); };
  }, [value]);
  return <span ref={element} className={`terminal-number ${signed ? numericTone(value) : ""}`} style={{ minWidth: `${width}ch` }}>{children}</span>;
}

export function TokenAvatar({ token, size = 32 }: { token: Pick<TokenView, "symbol" | "image">; size?: number }) {
  return <span className="terminal-avatar" style={{ width: size, height: size }} aria-hidden="true"><span>{token.symbol.slice(0, 2)}</span>{token.image && <img key={token.image} src={token.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}</span>;
}

export function PanelFeedback({ state, title, message, onRetry }: { state: PanelState; title: string; message?: string; onRetry?: () => void }) {
  return <div className="terminal-feedback" role={state === "error" ? "alert" : "status"} aria-busy={state === "loading"}><p>{title}</p>{message && <span>{message}</span>}{onRetry && <button type="button" className="terminal-button" onClick={onRetry}>Coba lagi</button>}</div>;
}

export function TerminalDrawer({ open, onOpenChange, title, description, kind = "right", children, footer, initialFocusRef, restoreFocusRef }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
   kind?: "scanner" | "ticket" | "lane" | "right";
  children: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  return <RadixDialog.Root open={open} onOpenChange={onOpenChange}><RadixDialog.Portal><div className="terminal-portal"><RadixDialog.Overlay className="terminal-scrim" /><RadixDialog.Content
    className={`terminal-drawer terminal-drawer-${kind}`}
    aria-describedby={description ? undefined : undefined}
    onOpenAutoFocus={(event) => { if (initialFocusRef?.current) { event.preventDefault(); initialFocusRef.current.focus(); } }}
    onCloseAutoFocus={(event) => { if (restoreFocusRef.current?.isConnected) { event.preventDefault(); restoreFocusRef.current.focus(); } }}
  >{kind === "ticket" && <span className="terminal-sheet-handle" aria-hidden="true" />}<header className="terminal-drawer-header"><div><RadixDialog.Title>{title}</RadixDialog.Title>{description && <RadixDialog.Description>{description}</RadixDialog.Description>}</div><RadixDialog.Close asChild><button type="button" className="terminal-icon" aria-label={kind === "scanner" ? "Tutup scanner" : kind === "ticket" ? "Tutup ticket simulasi" : "Tutup panel"}><X size={18} /></button></RadixDialog.Close></header><div className="terminal-drawer-body">{children}</div>{footer && <footer className="terminal-drawer-footer">{footer}</footer>}</RadixDialog.Content></div></RadixDialog.Portal></RadixDialog.Root>;
}
