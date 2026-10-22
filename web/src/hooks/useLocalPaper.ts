import { useEffect, useState } from "react";
import { addPaperCash, createPaperLedger, fillPaperOrder, PAPER_STORAGE_KEY, restorePaperLedger, updatePaperMarks } from "@/lib/localPaper";
import type { PaperLedger } from "@/lib/localPaper";
import type { PaperSide, QuoteView, TokenView } from "@/lib/terminal";

function initialState() {
  const fresh = { ledger: createPaperLedger(), storageError: null as string | null, message: null as string | null };
  if (typeof window === "undefined") return fresh;
  try {
    const stored = window.localStorage.getItem(PAPER_STORAGE_KEY);
    if (!stored) return fresh;
    const ledger = restorePaperLedger(JSON.parse(stored));
    return ledger ? { ...fresh, ledger } : { ...fresh, storageError: "Ledger lokal tersimpan tidak valid. Kas virtual kembali ke saldo awal." };
  } catch {
    return { ...fresh, storageError: "Penyimpanan browser tidak tersedia atau tidak terbaca. Simulasi berjalan di memori tab ini." };
  }
}

export function useLocalPaper(tokens: TokenView[]) {
  const [state, setState] = useState(initialState);
  useEffect(() => {
    try {
      window.localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(state.ledger));
    } catch {
      setState((previous) => previous.storageError ? previous : { ...previous, storageError: "Ledger lokal belum tersimpan. Penyimpanan browser tidak tersedia; data hanya di tab ini." });
    }
  }, [state.ledger]);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== PAPER_STORAGE_KEY || event.storageArea !== window.localStorage) return;
      try {
        const ledger = event.newValue === null ? createPaperLedger() : restorePaperLedger(JSON.parse(event.newValue));
        if (ledger) setState((previous) => ({ ...previous, ledger, message: "Ledger lokal diperbarui dari tab lain." }));
        else setState((previous) => ({ ...previous, storageError: "Perubahan ledger dari tab lain tidak valid; saldo terakhir dipertahankan." }));
      } catch { setState((previous) => ({ ...previous, storageError: "Perubahan penyimpanan lokal tidak dapat dibaca." })); }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  useEffect(() => {
    setState((previous) => {
      const ledger = updatePaperMarks(previous.ledger, tokens);
      return ledger === previous.ledger ? previous : { ...previous, ledger };
    });
  }, [tokens]);

  const apply = (result: (ledger: PaperLedger) => ReturnType<typeof addPaperCash>, message: string) => {
    setState((previous) => {
      const next = result(previous.ledger);
      return next.ok ? { ...previous, ledger: next.ledger, message } : { ...previous, message: next.error };
    });
  };
  return {
    ...state,
    submit: (token: TokenView, side: PaperSide, amount: string, quote: QuoteView | null, now: number) => apply((ledger) => fillPaperOrder(ledger, token, side, amount, quote, now), `${side === "buy" ? "Buy" : "Sell"} ${token.symbol} dicatat di ledger lokal.`),
    topUp: (amount: string) => apply((ledger) => addPaperCash(ledger, amount), "Kas virtual ditambahkan ke ledger lokal."),
    clearMessage: () => setState((previous) => previous.message ? { ...previous, message: null } : previous),
    reset: () => setState((previous) => ({ ...previous, ledger: createPaperLedger(), message: "Ledger lokal direset ke $10,000 virtual." })),
  };
}
