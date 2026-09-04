#!/bin/bash
B="https://storage.googleapis.com/lablab-video-submissions/submissions"
dl () { # $1 = name, $2 = path
  if [ ! -f "vid/$1.mp4" ]; then
    curl -sL --max-time 180 "$B/$2" -o "vid/$1.mp4" || echo "FAIL $1"
  fi
  printf "%-14s %s\n" "$1" "$(ls -la vid/$1.mp4 2>/dev/null | awk '{printf "%.1f MB", $5/1048576}')"
}
dl skew        z3gh0hwc98elfgn7lwrsrcj4/yti23vcucl360hzi7w1zorfm/video/video_wd0t23qzkws9y6dhz2mxb7it.mp4
dl alphapilot  n996tjnlzq1bc1splmg5o7oz/amfxcctkiyeulpn9wlofh79x/video/video_cbyfzktshs036an57zr08kxz.mp4
dl sentrytheta df271i5de9437ac09tt98v62/qlex9luuz9euotnszeaq4khi/video/video_tsa37dfol205pw73hbv1tl4m.mp4
dl delphi      wajg9c60ptawh1ec8yct6qz1/ue77qez4vl43eirvep7s0skd/video/video_f41qbzio45c7juvxcqrqzzi8.mp4
dl printrunner t7cm9x8v83x0sbgj3a418a6c/dxwne099x4oe7mqdd64fmt1w/video/video_q7esjdof6hn9mlfj4xbgj6pl.mp4
