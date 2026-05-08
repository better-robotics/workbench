#!/bin/bash
# Skip sudo password prompt when the calling tty is ttyGS0 (USB-CDC ACM
# gadget — the dashboard's Serial console). Physical USB access is
# already root-equivalent (single-user mode is one reboot away), so
# requiring a sudo password on ttyGS0 buys no real security and
# strands users who never set USER_PASS during prep (autologin uses an
# unguessable random hash). BLE shell + SSH paths stay password-gated.
#
# Idempotent: only inserts the PAM line once.
set -e
PAM_FILE="/etc/pam.d/sudo"
PAM_LINE="auth sufficient pam_succeed_if.so quiet tty = ttyGS0"
[ -f "$PAM_FILE" ] || exit 0
grep -qF "$PAM_LINE" "$PAM_FILE" && exit 0
# Insert after the `#%PAM-1.0` header (line 1) so the bypass evaluates
# before `@include common-auth` would prompt.
sed -i "1a ${PAM_LINE}" "$PAM_FILE"
