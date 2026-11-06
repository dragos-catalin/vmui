#!/bin/bash
# Runs INSIDE the booted image copy (never shipped: smoke.sh injects it). Phase from the kernel
# command line (vatra.smoke=1|2). Prints "SMOKE ..." lines on the console and into
# /boot/firmware/smoke-<phase>.txt, then powers the VM off.
#   1: wired, no internet  -> offline first boot: firstboot, baked stack, unclaimed hub, setup code
#   2: no network, 2 hwsim -> hotspot + captive portal reached from a client radio in a netns
set -uo pipefail
PH="$(sed -n 's/.*vatra\.smoke=\([0-9]\).*/\1/p' /proc/cmdline)"
mkdir -p /var/lib/vatra-smoke
OUT="/var/lib/vatra-smoke/smoke-$PH.txt"
: > "$OUT"
FAIL=0
say() { echo "SMOKE $*" | tee -a "$OUT" > /dev/console; }
check() { if [ "$2" = ok ]; then say "ok   $1"; else say "FAIL $1 ($2)"; FAIL=1; fi; }
waitfor() { local t=$1; shift; for _ in $(seq 1 "$t"); do "$@" >/dev/null 2>&1 && return 0; sleep 5; done; return 1; }
discover() { curl -fsS --max-time 5 http://127.0.0.1:3737/api/discover; }
unclaimed() { discover | grep -q '"claimed":false'; }

say "phase $PH start $(date -u +%T) host $(hostname) kernel $(uname -r)"
findmnt /boot/firmware >/dev/null && check "boot partition mounted" ok || check "boot partition mounted" "$(systemctl status boot-firmware.mount --no-pager 2>&1 | tail -n 5 | tr '\n' ' ')"
systemctl --failed --no-legend | grep -q . && say "failed units: $(systemctl --failed --no-legend | awk '{print $2}' | tr '\n' ' ')"
case "$PH" in
1)
  [[ "$(hostname)" =~ ^vatra-[0-9a-f]{4}$ ]] && check hostname ok || check hostname "$(hostname)"
  root_kb=$(df -k --output=size / | tail -n1 | tr -d ' ')
  [ "$root_kb" -gt 6000000 ] && check "root grown to $((root_kb / 1024)) MiB" ok || check "root grown" "$root_kb KiB"
  for u in NetworkManager docker avahi-daemon vatra-netsetup vatra-bootnote.path; do
    waitfor 24 systemctl is-active --quiet "$u" && check "active $u" ok || check "active $u" "$(systemctl is-active "$u")"
  done
  systemctl is-enabled --quiet vatra-updater.timer && check "updater timer enabled" ok || check "updater timer" missing
  [ -x /usr/local/bin/cosign ] && check "cosign present" ok || check cosign missing
  [ -f /etc/avahi/services/vatra.service ] && grep -q _vatra._tcp /etc/avahi/services/vatra.service \
    && check "avahi _vatra._tcp" ok || check "avahi service" missing
  if waitfor 720 unclaimed; then
    check "hub unclaimed: $(discover)" ok
  else
    check "hub unclaimed" "$(discover 2>&1 | head -c 200); stack: $(cat /var/lib/vatra/stack-status 2>/dev/null)"
    docker ps -a >> "$OUT" 2>&1; journalctl -u vatra-stack --no-pager | tail -n 40 >> "$OUT"
  fi
  [ -z "$(ls /opt/vatra/images 2>/dev/null)" ] && check "baked images loaded and removed" ok || check "baked images" "$(ls /opt/vatra/images)"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' vatra 2>/dev/null)" = true ] && check "vatra read-only" ok || check "vatra read-only" no
  code="$(cat /srv/vatra/data/vatra-setup-code.txt 2>/dev/null | tr -d '[:space:]')"
  [[ "$code" =~ ^[0-9]{6}$ ]] && check "setup code generated" ok || check "setup code" "${code:-none}"
  note_has() { grep -q "Setup code: ${code:0:3} ${code:3:3}" /boot/firmware/vatra-setup.txt; }
  waitfor 24 note_has && check "setup code on the boot partition" ok || check "boot note" "$(head -c 300 /boot/firmware/vatra-setup.txt 2>&1)"
  nmcli -t -f NAME con show --active | grep -qx vatra-setup && check "no hotspot while wired" "hotspot up" || check "no hotspot while wired" ok
  say "stack: $(cat /var/lib/vatra/stack-status 2>/dev/null)"
  # the host checks /api/discover through the port forward meanwhile
  sleep 90
  ;;
2)
  hot() { nmcli -t -f NAME con show --active | grep -qx vatra-setup; }
  if waitfor 120 hot; then check "hotspot up after the offline grace" ok; else check hotspot "never came up"; journalctl -u vatra-netsetup --no-pager | tail -n 30 >> "$OUT"; fi
  ap="$(nmcli -g GENERAL.DEVICES con show vatra-setup 2>/dev/null)"
  cli="$(ls /sys/class/net | grep '^wl' | grep -vx "$ap" | head -n1)"
  ident="$(python3 /opt/vatra/bin/vatra_netsetup.py --identity)"
  ssid="$(echo "$ident" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ssid"])')"
  psk="$(echo "$ident" | python3 -c 'import json,sys;print(json.load(sys.stdin)["psk"])')"
  grep -q "$ssid  password  $psk" /boot/firmware/vatra-setup.txt && check "hotspot name + password on the boot partition" ok || check "boot note hotspot" missing
  say "ap=$ap client=$cli ssid=$ssid"
  if [ -n "$cli" ]; then
    nmcli dev set "$cli" managed no
    phy="$(cat "/sys/class/net/$cli/phy80211/name")"
    ip netns add cli && iw phy "$phy" set netns name cli
    printf 'network={\n ssid="%s"\n psk="%s"\n key_mgmt=WPA-PSK\n proto=RSN\n}\n' "$ssid" "$psk" > /run/wpa-smoke.conf
    ip netns exec cli ip link set "$cli" up
    ip netns exec cli wpa_supplicant -B -i "$cli" -c /run/wpa-smoke.conf >/dev/null
    assoc() { ip netns exec cli iw dev "$cli" link | grep -q "SSID: $ssid"; }
    waitfor 24 assoc && check "client joined $ssid with WPA2" ok || check "client association" "$(ip netns exec cli iw dev "$cli" link)"
    ip netns exec cli ip addr add 10.42.0.50/24 dev "$cli"
    waitfor 12 ip netns exec cli curl -s -o /dev/null --max-time 3 http://10.42.0.1/status.json
    loc="$(ip netns exec cli curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 -H 'Host: connectivitycheck.gstatic.com' http://10.42.0.1/generate_204)"
    [ "$loc" = "302 http://10.42.0.1/" ] && check "OS connectivity probe -> captive portal" ok || check "probe redirect" "$loc"
    page="$(ip netns exec cli curl -s --max-time 5 -H 'Accept-Language: ro-RO' http://10.42.0.1/)"
    echo "$page" | grep -q 'Conectează hubul Vatra' && check "portal page (ro)" ok || check "portal page" "$(echo "$page" | head -c 200)"
    code="$(ip netns exec cli curl -s -o /dev/null -w '%{http_code}' --max-time 5 --data 'ssid=Home&password=abc' http://10.42.0.1/connect)"
    [ "$code" = 400 ] && check "weak wifi password refused" ok || check "weak password" "$code"
    dns="$(ip netns exec cli python3 - <<'PY'
import socket, struct
q = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(p)]) + p.encode() for p in "example.com".split(".")) + b"\0" + struct.pack(">HH", 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5); s.sendto(q, ("10.42.0.1", 53))
r = s.recv(512); print(socket.inet_ntoa(r[-4:]))
PY
)"
    [ "$dns" = 10.42.0.1 ] && check "every DNS name answers the hub" ok || check "captive DNS" "$dns"
  fi
  waitfor 120 unclaimed && check "hub serves again after a reboot, offline" ok || check "offline hub" "$(discover 2>&1 | head -c 200)"
  ;;
*) say "no phase"; FAIL=1 ;;
esac
say "phase $PH $([ $FAIL = 0 ] && echo pass || echo fail)"
sync
systemctl poweroff
