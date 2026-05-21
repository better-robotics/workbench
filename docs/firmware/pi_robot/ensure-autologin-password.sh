#!/bin/bash
# Repairs already-deployed Pis whose user has '*' in /etc/shadow (from
# adduser --disabled-password). agetty --autologin invokes `login -f`, but
# PAM account-management can still reject a disabled-password account and
# fall back to a password prompt. Giving the account a real random hash
# that the user never sees resolves it; SSH still uses the dashboard key.
# Idempotent: leaves existing passwords alone.
set -e
USER_NAME="${1:-robot}"
entry=$(getent shadow "$USER_NAME" || true)
if [ -z "$entry" ]; then exit 0; fi
hash=$(echo "$entry" | cut -d: -f2)
case "$hash" in
    ""|"*")
        randpass=$(head -c 32 /dev/urandom | base64)
        echo "$USER_NAME:$randpass" | chpasswd
        ;;
esac
