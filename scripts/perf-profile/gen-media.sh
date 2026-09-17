#!/usr/bin/env bash
# Synthetic media pool for the density stress (profiler task eebh7ah).
# Videos: ffmpeg testsrc2/gradients, varied resolutions incl. 1344x768 (H3 res)
# and 768x1344 portrait, 2-6 s, H.264 yuv420p +faststart, CRF 30 (small files).
# Stills: gradient/smptehdbars PNG + JPEG at varied resolutions.
# Every file varies a parameter so content hashes are DISTINCT (the blob store
# is content-addressed; identical bytes dedupe to one blob).
set -euo pipefail
cd "$(dirname "$0")/../..   # worktree root
OUT=test-results/perf-profile/media
export OUT
mkdir -p "$OUT/video" "$OUT/still"

# 170 distinct videos: i varies hue/pattern/duration/resolution.
gen_video() {
  local i=$1
  local res ress=("640x360" "832x480" "960x540" "1344x768" "768x1344" "1080x608")
  res=${ress[$(( i % ${#ress[@]} ))]}
  local dur=$(( 2 + (i % 5) ))         # 2..6 s
  local hue=$(( (i * 37) % 360 ))
  local src
  if (( i % 3 == 0 )); then
    src="gradients=size=${res}:speed=0.05:c0=0x003344:c1=0x882200:c2=0x001133:c3=0xff8844"
  elif (( i % 3 == 1 )); then
    src="testsrc2=size=${res}:rate=24"
  else
    src="smptehdbars=size=${res}:rate=24"
  fi
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src" -t "$dur" \
    -vf "hue=h=${hue}:s=1.4" \
    -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart \
    -an "$OUT/video/clip-$(printf '%03d' "$i").mp4"
}
export -f gen_video
# shellcheck disable=SC2016
seq 0 169 | xargs -P "$(nproc)" -I{} bash -c 'gen_video {}'

# 140 distinct stills: alternate PNG / JPEG gradients + bars, varied res.
gen_still() {
  local i=$1
  local res ress=("512x288" "768x432" "1024x576" "1344x768" "768x1344" "896x512")
  res=${ress[$(( i % ${#ress[@]} ))]}
  local hue=$(( (i * 53) % 360 ))
  if (( i % 2 == 0 )); then
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "gradients=size=${res}:speed=0.05:c0=0x102030:c1=0xcc5522:c2=0x0a0a20:c3=0x33ffcc" \
      -vf "hue=h=${hue}" -frames:v 1 "$OUT/still/still-$(printf '%03d' "$i").png"
  else
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "smptehdbars=size=${res}" \
      -vf "hue=h=${hue}:s=1.6" -frames:v 1 -q:v 8 "$OUT/still/still-$(printf '%03d' "$i").jpg"
  fi
}
export -f gen_still
# shellcheck disable=SC2016
seq 0 139 | xargs -P "$(nproc)" -I{} bash -c 'gen_still {}'

echo "videos: $(ls "$OUT/video" | wc -l), stills: $(ls "$OUT/still" | wc -l)"
du -sh "$OUT/video" "$OUT/still"
