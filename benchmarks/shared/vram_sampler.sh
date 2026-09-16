#!/bin/zsh
# Sample GPU VRAM + system RAM every 2s while $1 (pid) is alive; write TSV.
PID="${1:?pid}"
OUT="${2:?out.tsv}"
echo -e "t_s\tvram_mib\tgpu_util\tram_used_gib\tram_total_gib" > "$OUT"
T0=$(date +%s)
while kill -0 "$PID" 2>/dev/null; do
  V=$(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits | head -1 | tr -d ' ')
  R=$(free -g | awk '/^Mem:/{print $3"/"$2}')
  echo -e "$(( $(date +%s) - T0 ))\t${V}\t${R}" >> "$OUT"
  sleep 2
done
