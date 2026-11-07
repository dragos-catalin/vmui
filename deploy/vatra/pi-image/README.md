# Vatra hub images (P5-01, P5-02, P5-05)

| Image                                        | Built by                                                 | Runs on                                             |
| -------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| `vatra-hub-pi5-<v>.img.xz`                   | `pi-image/build.sh` (rpi-image-gen v2.9.0, native arm64) | Raspberry Pi 5                                      |
| `vatra-hub-pi4-<v>.img.xz`                   | same                                                     | Raspberry Pi 4 / 400 / CM4                          |
| `vatra-hub-x86-<v>.qcow2` / `.ova` / `.vhdx` | `x86/build.sh` (Packer + QEMU/KVM)                       | Proxmox, KVM, Unraid / VirtualBox, VMware / Hyper-V |
| HAOS add-on `haos-addon/vatra`               | Supervisor builds it FROM the release image              | an existing Home Assistant OS                       |

All of them carry the same stack: Docker, `deploy/vatra/compose.yaml`, the Vatra and Mosquitto
images baked in (`bake.sh`, loaded at first boot, so a hub with no internet still answers and can
be claimed), Home Assistant + ESPHome pulled by digest once online, `vatra-updater` with its
nightly timer, avahi `_vatra._tcp`. Installation into a rootfs is one script for both:
`hub-install.sh --platform pi|x86`.

## First boot

1. `vatra-firstboot`: hostname `vatra-xxxx`, root partition grown to the disk, SSH host keys.
2. `vatra-stack`: loads the baked images, starts Mosquitto + Vatra, then HA + ESPHome with backoff.
3. The hub has no owner and prints a six-digit setup code. Pi: `vatra-setup.txt` on the boot
   partition (readable from any PC), rewritten when the code changes or the hub is claimed.
   x86: the VM console.
4. No cable and no wifi (Pi): after 90 s `vatra-netsetup` opens the WPA2 hotspot `Vatra-XXXX`
   (password in `vatra-setup.txt`); every DNS name answers the hub, phones open the captive portal
   (en/ro) to pick the home wifi. The portal listens only on the hotspot and only while it is up.
   Alternative: `vatra-wifi.txt` on the boot partition (`SSID=` / `PASSWORD=`), consumed and
   deleted at boot, outcome in `vatra-wifi-result.txt`.

No account has a password; SSH accepts keys only and none is installed.

## Build and smoke (cloud only)

```powershell
node scripts/e2e-cloud/run.mjs --arm64 --machine c4a-standard-16 --max-run 3h --cmd "bash deploy/vatra/pi-image/build.sh" --fetch test-results
node scripts/e2e-cloud/run.mjs --nested --machine n2-standard-8 --max-run 3h --cmd "bash deploy/vatra/x86/build.sh" --fetch test-results
```

`VATRA_IMAGE_REF=ghcr.io/<owner>/vatra@sha256:...` bakes a released image instead of building
this tree. Artefacts go to `gs://vmui-e2e-runs-dragos-devcloud/runs/<id>/{pi,x86}-image/`
(14-day lifecycle) plus `os_list.json` and `SHA256SUMS`.

The Pi smoke boots a copy of the Pi 4 image in QEMU `virt` (same rootfs, Debian's generic arm64
kernel): boot 1 wired with no internet (firstboot, baked stack, unclaimed `/api/discover` from the
host, setup code on the boot partition), boot 2 with no NIC and two `mac80211_hwsim` radios
(hotspot, WPA2 join from a client namespace, captive redirect, captive DNS, portal in Romanian,
weak password refused, hub back after reboot). The Pi firmware/boot chain itself is real-hardware
QA. Unit tests: `python -m unittest deploy/vatra/pi-image/test_vatra_netsetup.py`.

## A/B system images (P5-04)

`VATRA_AB=1 bash deploy/vatra/x86/build.sh` builds the x86 A/B disk (EROFS slots A/B, ext4 data,
systemd-boot ESP, Rugix Ctrl v1.4.0 as init) plus its `.rugixb` bundle and runs the A/B smoke;
`pi-image/ab.sh` turns a classic Pi card into the tryboot A/B card. Layout, update flow, status
fields and the real-board QA runbook: [docs/product/os-ab.md](../../../docs/product/os-ab.md).

## Raspberry Pi Imager

`os_list.json` (built per release) is a custom repository: Imager → _App options_ → _Content
repository_ → _Use custom URL_. `init_format` is `none`: Imager's customisation is not used, the
hub is configured from the app.
