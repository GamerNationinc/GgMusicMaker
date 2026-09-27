#!/usr/bin/env bash
# CI audio: a real-time virtual sound card (PulseAudio null sink) behind
# ALSA's default device, so the native engine's clock runs at wall speed.
set -e
pulseaudio -D --exit-idle-time=-1 --system=false --disallow-exit
for i in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.25; done
pactl load-module module-null-sink sink_name=ci_null >/dev/null
pactl set-default-sink ci_null
printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > ~/.asoundrc
