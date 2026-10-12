# ADR-0003 (devcloud): macOS and iOS on demand

Status: accepted by the owner on 2026-10-11, with an explicit risk acceptance for the owner-only path.

## Context

- **Platforms.** The owner wants Windows, Linux, macOS, Android and iOS (through macOS), all scalable on demand.
- **The existing local VM cannot run the iOS Simulator.** The VM is OSX-KVM under WSL2 QEMU, documented in `docs/local-kvm-macos.md` and `scripts/boot-mac.sh`. Measured on that VM:
  - `MTLCreateSystemDefaultDevice()` returns NULL (emulated VGA, no Metal).
  - Xcode is not installed, because Apple ID sign-in fails: the SMBIOS reports the placeholder serial `W00000000001`.
  - Inside the guest, `kern.hv_support: 0`.
  - The working Simulator path in `vfio/` needs bare-metal Linux with an AMD GPU passed through. That route was decided against on 2026-08-19.
- **No compliant macOS on GCP.** GCE nested virtualisation runs KVM on C4 (Intel; C4D has no nested virt), so OSX-KVM can boot there. It would still have no GPU, so no Metal, so no Simulator.
- **Licensing.** The macOS licence permits virtualisation only on Apple-branded hardware. A GCE host is not Apple hardware.

## Decision

1. **Owner-only path, on GCE, with the risk accepted by the owner.**
   - What runs: OSX-KVM on a `c4-standard-16` with nested virtualisation, in `dragos-devcloud`, using the same golden qcow2 as the local VM (macOS 26.6.2 overlay).
   - Who can use it: the owner only. In codai the option is visible only to `vladulescu.catalin@gmail.com` (super_admin), never to customers. It must not be marketed or resold.
   - Expected capability: headless macOS for shell work, Swift CLI tools and builds that need no Metal. No iOS Simulator UI unless a software renderer appears.
2. **Customer path (codai production), compliant:**
   - **Per job, CI-shaped work:** GitHub `macos-26` runners. Per-minute billing, no minimum.
   - **Interactive sessions and agents:** a pool of Scaleway Mac mini M4 hosts at about €0.22/h, with a 24 h minimum per host. Each host runs **Tart** (2.40.x) for instant clones of a golden Xcode image, at most 2 VMs per host as the EULA allows. Orchard schedules the VMs.
   - **AWS EC2 Mac** (mac-m4) is the fallback when M4 Pro/Max sizes or AWS integration are needed.
3. **Placement.** vmui gets a `scaleway-mac` provider and a Tart integration. agentq's placement treats `os=macos` jobs as follows:
   - Use the owner VM only when the requester is the owner and no Metal is needed.
   - Otherwise use a Tart VM on a Scaleway host.
   - Use GitHub `macos-26` for CI.

## Consequences

- **What the owner path cannot do.** It does not deliver a working iOS Simulator. That needs Metal, which means real Apple silicon (the Scaleway/Tart path) or a GPU-passthrough host.
- **Billing floor.** A Scaleway host costs at least 24 h once started (about €5.3). Pool sizing must account for this.
- **Tracker.** Implementation is DC-053 (owner GCE) and DC-054 (customer pool).
