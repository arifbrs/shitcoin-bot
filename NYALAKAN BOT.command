#!/bin/bash
# Klik dua kali dari Finder. macOS membuka ini di Terminal, dengan cwd = home,
# jadi harus pindah sendiri ke folder proyek.
cd "$(dirname "$0")" || exit 1
clear
echo "╭──────────────────────────────────────────────╮"
echo "│           MENYALAKAN BOT MICINCLOUD          │"
echo "╰──────────────────────────────────────────────╯"
echo
./bot.sh start
echo
echo "Dashboard: http://localhost:4317/app"
echo
echo "Jendela ini boleh ditutup — bot jalan di latar belakang."
echo "Untuk mematikan: klik dua kali \"MATIKAN BOT.command\""
echo
read -n 1 -s -r -p "Tekan tombol apa saja untuk menutup…"
