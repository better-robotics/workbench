#!/bin/bash
# Skip sudo password prompt when the calling tty is ttyGS0 (USB-CDC ACM
# gadget — the dashboard's Serial console). Physical USB access is
# already root-equivalent (single-user mode is one reboot away), so
# requiring a sudo password on ttyGS0 buys no real security and
# strands users who never set USER_PASS during prep (autologin uses an
# unguessable random hash). BLE shell + SSH paths stay password-gated.
#
# `tty in ttyGS0:/dev/ttyGS0` — PAM_TTY comes through as the short name
# on some agetty/login stacks and as the /dev/-prefixed full path on
# others (Bookworm hits both depending on PAM stack). The original
# `tty = ttyGS0` rule missed the /dev-prefixed case in the field, so
# recovery shells kept being prompted for a password they didn't have.
#
# Idempotent: drops any earlier pi-robot tty-bypass line on this file
# before inserting the current one, so script reruns converge.
set -e
PAM_FILE="/etc/pam.d/sudo"
PAM_LINE="auth sufficient pam_succeed_if.so quiet tty in ttyGS0:/dev/ttyGS0"
[ -f "$PAM_FILE" ] || exit 0
sed -i '\|pam_succeed_if\.so.*tty.*ttyGS0|d' "$PAM_FILE"
# Insert after the `#%PAM-1.0` header (line 1) so the bypass evaluates
# before `@include common-auth` would prompt.
sed -i "1a ${PAM_LINE}" "$PAM_FILE"
