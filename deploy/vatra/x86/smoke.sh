#!/usr/bin/env bash
# Boot a copy of the x86 qcow2 the way a user would (e1000 NIC like the OVA, restricted user
# network = no internet) and check from the host: firstboot, baked stack, an unclaimed hub on
# :3737, the setup code on the console. Then boot it again (state survives).
#   bash smoke.sh <vatra-hub-x86.qcow2> <out dir> [kvm|tcg]
set -euo pipefail
QCOW="$1"; OUT="$2"; ACCEL="${3:-kvm}"
X="$(cd "$(dirname "$0")" && pwd)"
W=/srv/vatra-x86-smoke; rm -rf "$W"; mkdir -p "$W"
say() { echo "== $*" | tee -a "$OUT/smoke.txt"; }
qemu-img create -q -f qcow2 -b "$QCOW" -F qcow2 "$W/hub.qcow2" 24G
FAIL=0
check() { if [ "$2" = ok ]; then say "ok   $1"; else say "FAIL $1 ($2)"; FAIL=1; fi; }
command -v socat >/dev/null || apt-get install -y -qq socat >/dev/null

boot() {
  qemu-system-x86_64 -machine q35 -accel "$ACCEL" -cpu max -smp 2 -m 4096 -display none -serial "file:$OUT/console-$1.log" \
    -drive "file=$W/hub.qcow2,if=virtio,cache=unsafe" \
    -netdev user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:23737-:3737 -device e1000,netdev=n0,romfile= \
    -device virtio-serial -chardev "socket,path=$W/qga,server=on,wait=off,id=qga0" \
    -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 \
    -monitor "unix:$W/mon,server,nowait" -daemonize -pidfile "$W/qemu.pid"
}
discover() { curl -fsS --max-time 4 http://127.0.0.1:23737/api/discover; }
unclaimed() { discover | grep -q '"claimed":false'; }
waitfor() { local t=$1; shift; for _ in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 5; done; return 1; }
stop() {
  echo system_powerdown | socat - "UNIX-CONNECT:$W/mon" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do kill -0 "$(cat "$W/qemu.pid")" 2>/dev/null || return 0; sleep 2; done
  kill "$(cat "$W/qemu.pid")"
}
# what the guest itself sees (via qemu-guest-agent): addresses, listeners, containers, logs
guest_dump() {
  timeout 150 python3 "$X/qga-exec.py" "$W/qga" 'echo "== ip"; ip -br a; echo "== listen"; ss -ltnp; echo "== docker"; docker ps -a; echo "== vatra"; docker logs --tail 60 vatra 2>&1; echo "== stack"; journalctl -b -u vatra-stack --no-pager | tail -n 30; echo "== net"; journalctl -b -u systemd-networkd --no-pager | tail -n 15' \
    > "$OUT/guest-$1.txt" 2>&1 || echo "guest agent unreachable" >> "$OUT/guest-$1.txt"
}

say "boot 1 ($ACCEL)"
boot 1
T=$(date +%s)
if waitfor 180 unclaimed; then
  check "unclaimed hub on :3737 after $(( $(date +%s) - T )) s, offline: $(discover)" ok
else
  check "hub on :3737" "$(discover 2>&1 | head -c 200)"
fi
guest_dump 1
drivers="$(timeout 90 python3 "$X/qga-exec.py" "$W/qga" 'for m in e1000 e1000e vmxnet3 hv_netvsc virtio_net; do modinfo -n $m >/dev/null 2>&1 && printf "%s " $m; done' 2>/dev/null)"
[ "$(echo "$drivers" | wc -w)" = 5 ] && check "NIC drivers for KVM/VirtualBox/VMware/Hyper-V: $drivers" ok || check "NIC drivers" "only: $drivers"
code_on_console() { grep -aqE 'Setup code: [0-9]{3} [0-9]{3}' "$OUT/console-1.log"; }
waitfor 24 code_on_console && check "setup code on the console" ok || check "setup code on the console" "not shown"
grep -aqE 'vatra-[0-9a-f]{4} login:' "$OUT/console-1.log" && check "hostname vatra-xxxx" ok || check hostname "$(grep -ao '[a-z0-9-]* login:' "$OUT/console-1.log" | tail -n1)"
stop
say "boot 2"
boot 2
waitfor 120 unclaimed && check "hub back after a reboot" ok || { check "reboot" "$(discover 2>&1 | head -c 200)"; guest_dump 2; }
stop
sed -i -E 's/(code: |configurare: )[0-9]{3} [0-9]{3}/\1*** ***/' "$OUT"/console-*.log "$OUT"/guest-*.txt 2>/dev/null || true
[ "$FAIL" = 0 ] && say "SMOKE OK" || { say "SMOKE FAILED"; exit 1; }
