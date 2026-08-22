#!/bin/bash
cd "$(dirname "$0")" || exit 1
clear
echo "╭──────────────────────────────────────────────╮"
echo "│           MEMATIKAN BOT MICINCLOUD           │"
echo "╰──────────────────────────────────────────────╯"
echo
./bot.sh stop
echo
read -n 1 -s -r -p "Tekan tombol apa saja untuk menutup…"
