#!/bin/bash
# Menaruh cookie pump.fun dari CLIPBOARD ke .env tanpa nilainya pernah muncul di layar,
# di log, atau di riwayat shell. Owner cukup menyalin; tidak perlu mengirim ke siapa pun.
cd "$(dirname "$0")/.." || exit 1
C=$(pbpaste)
[ -z "$C" ] && { echo "  clipboard kosong — salin dulu nilai header cookie-nya"; exit 1; }
# Toleran terhadap salin-tempel dari DevTools yang ikut membawa awalan "cookie:"
C=$(printf '%s' "$C" | sed -E 's/^[[:space:]]*[Cc]ookie:[[:space:]]*//' | tr -d '\r\n')
case "$C" in
  *=*) : ;;
  *) echo "  isi clipboard tidak terlihat seperti header cookie (tidak ada '='). Batal."; exit 1 ;;
esac
python3 - "$C" <<'PY'
import sys,re,io
c=sys.argv[1]
src=open('.env',encoding='utf-8').read().split('\n')
out=[l for l in src if not l.startswith('PUMPFUN_COOKIE=')]
while out and out[-1]=='': out.pop()
out.append('PUMPFUN_COOKIE='+c)
open('.env','w',encoding='utf-8').write('\n'.join(out)+'\n')
names=sorted({m.split('=')[0].strip() for m in c.split(';') if '=' in m})
print(f"  tersimpan ke .env — {len(c)} karakter, berakhir '…{c[-4:]}'")
print(f"  nama cookie di dalamnya: {', '.join(names[:8])}{'…' if len(names)>8 else ''}")
PY
