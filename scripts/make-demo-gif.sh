#!/usr/bin/env bash
# Turns the Playwright demo recording (e2e/tests/demo-video.spec.ts) into the README GIF, and writes a
# contact sheet PNG next to it so a reviewer can check the frames without playing anything.
#
#   scripts/make-demo-gif.sh [input.webm] [output.gif]
#   defaults: e2e/demo-video/tour.webm -> e2e/demo-video/demo.gif (+ demo-contact-sheet.png)
#
# Two-pass palette: building it from frame differences (stats_mode=diff) spends the 256 colours on what
# moves, and diff_mode=rectangle re-dithers only the changed region, so static UI stays identical between
# frames and costs almost nothing. GitHub stops rendering images inline at 10 MB; 8 MB leaves headroom,
# and each retry trades a little smoothness or sharpness for size until the GIF fits.
set -euo pipefail

in=${1:-e2e/demo-video/tour.webm}
out=${2:-e2e/demo-video/demo.gif}
sheet=${out%.gif}-contact-sheet.png
max_bytes=$((8 * 1024 * 1024))
# fps, width, colours: best first.
ladder=("12 960 256" "10 880 256" "10 800 192" "8 720 160" "8 640 128")

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done
[[ -f $in ]] || { echo "error: $in not found; record it with DEMO_VIDEO=1 npx playwright test (in e2e/)" >&2; exit 1; }
mkdir -p "$(dirname "$out")"

# The spec writes how long the recording stayed blank before the first paint; TRIM_START overrides it.
start=${TRIM_START:-$(cat "${in%.*}.start" 2>/dev/null || echo 0)}

# A webm written as a live stream can lack a container duration; the last packet's timestamp still has it.
duration() {
  local d
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1")
  if [[ -z $d || $d == N/A ]]; then
    d=$(ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "$1" | tail -n 1)
  fi
  echo "$d"
}
mb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1048576 }'; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for step in "${ladder[@]}"; do
  read -r fps width colours <<<"$step"
  filters="fps=$fps,scale=$width:-1:flags=lanczos"
  ffmpeg -v error -y -ss "$start" -i "$in" \
    -vf "$filters,palettegen=max_colors=$colours:stats_mode=diff" "$tmp/palette.png"
  ffmpeg -v error -y -ss "$start" -i "$in" -i "$tmp/palette.png" \
    -lavfi "$filters[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$out"
  size=$(wc -c <"$out")
  ((size <= max_bytes)) && break
  echo "$(mb "$size") MB at $fps fps, $width px, $colours colours is over the 8 MB budget; retrying smaller" >&2
done
((size <= max_bytes)) || { echo "error: $out is still $(mb "$size") MB at the smallest setting" >&2; exit 1; }

# Nine frames spread over the whole clip (one every ~3 s for a 27 s tour), tiled 3x3 at 480 px each.
clip=$(awk -v d="$(duration "$in")" -v s="$start" 'BEGIN { printf "%.3f", d - s }')
ffmpeg -v error -y -ss "$start" -i "$in" \
  -vf "fps=9/$clip,scale=480:-1:flags=lanczos,tile=3x3:padding=8:margin=8:color=0x71717a" -frames:v 1 "$sheet"

seconds=$(awk -v d="$(duration "$out")" 'BEGIN { printf "%.1f", d }')
echo "$out: $(mb "$size") MB, $seconds s, $fps fps, $width px, $colours colours"
echo "$sheet: 3x3 contact sheet"
