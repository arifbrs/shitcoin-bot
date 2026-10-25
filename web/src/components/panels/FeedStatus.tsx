import { RefreshCw, Radio } from "lucide-react";
import type { ConnectionStatus } from "@/hooks/useLiveStats";
import { formatAge } from "@/lib/dashboard";

interface Props {
  status: ConnectionStatus;
  error: string | null;
  age: number | null;
  onReconnect: () => void;
}

export function FeedStatus({ status, error, age, onReconnect }: Props) {
  const delayed = age !== null && age >= 90;
  const warning = error || status === "reconnecting" || delayed;
  const text = error ?? (status === "reconnecting"
    ? "Koneksi terputus. Angka yang terlihat adalah snapshot terakhir."
    : delayed ? "Belum ada snapshot baru. Status lane perlu diverifikasi kembali."
      : age === null ? "Menunggu snapshot pertama dari server…" : "Snapshot diterima langsung dari server");
  return (
    <div className={`feed-strip ${warning ? "feed-warning" : ""}`}>
      <div className="flex min-w-0 items-center gap-2.5" role="status"><Radio size={15} className="shrink-0" /><span>{text}</span></div>
      <div className="flex shrink-0 items-center gap-4">
        <span className="font-mono text-xs" aria-label="Usia snapshot">{formatAge(age)}</span>
        <button type="button" onClick={onReconnect} className="feed-retry"><RefreshCw size={13} />Sambungkan ulang</button>
      </div>
    </div>
  );
}

export function DashboardLoading() {
  return (
    <section aria-label="Memuat dashboard" aria-busy="true" className="dashboard-loading">
      <div><p className="eyebrow">Menghubungkan data</p><h2>Menyiapkan ruang monitoring.</h2><p>Ringkasan muncul setelah snapshot pertama diterima.</p></div>
      <div className="loading-grid" aria-hidden="true">{[0, 1, 2, 3].map((item) => <div key={item} className="loading-card" />)}</div>
    </section>
  );
}
