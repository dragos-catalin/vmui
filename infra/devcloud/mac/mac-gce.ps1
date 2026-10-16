<#
  devcloud DC-053: the owner's macOS VM (OSX-KVM, the same golden base + Tahoe overlay as the local
  WSL2 VM) on a GCE C4 VM with nested virtualization. Owner only (ADR-0003); never offered to users.

  Shape: c4-standard-16 (Intel, nested KVM L1) in dragos-devcloud europe-central2-a, no external IP,
  Ubuntu 24.04 host, Hyperdisk Balanced data disk "mac-data" with the qcow2 chain, Cloud NAT for apt,
  IAP for SSH/VNC/SPICE (firewall 35.235.240.0/20 -> tcp:22 on tag devcloud-mac only). On demand;
  after -IdleMin minutes with no session the host SUSPENDS itself with macOS still running
  (resume ~22 s, guest state kept). -Stop is the full clean shutdown.

  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Upload            # local qcow2 chain -> GCS (once, ~1-4 h)
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Provision         # SA, firewall, NAT, VM + data disk
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Start | -Stop | -Status
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Tunnel            # localhost:10022/5900/5930 like the local VM
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Snapshot          # data-disk snapshot (also weekly schedule)
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -UpdateHost        # push startup script + boot-mac.sh, re-run
  pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Delete            # VM only; the data disk is kept (asks)
#>
param(
  [string]$Project = 'dragos-devcloud', [string]$Zone = 'europe-central2-a', [string]$Name = 'vmui-mac',
  [string]$Machine = 'c4-standard-16', [int]$DataGb = 300, [string]$Bucket = 'dragos-devcloud-mac', [string]$Prefix = 'v1',
  [string]$Disk = 'mac-tahoe.qcow2', [int]$RamMb = 32768, [int]$Cores = 8, [int]$Threads = 16, [int]$IdleMin = 15,
  [string]$WslDistro = 'Ubuntu-24.04', [string]$WslVmDir = '/home/dragos/OSX-KVM',
  [switch]$Upload, [switch]$Provision, [switch]$Start, [switch]$Stop, [switch]$Status, [switch]$Tunnel,
  [switch]$Snapshot, [switch]$UpdateHost, [switch]$Delete
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..\..')).Path
$region = $Zone -replace '-[a-z]$', ''
$sa = "devcloud-mac@$Project.iam.gserviceaccount.com"
$role = "projects/$Project/roles/devcloudMacSelfStop"
$dataDisk = "$Name-data"
function G { $o = & gcloud @args 2>&1; if ($LASTEXITCODE) { throw "gcloud $($args -join ' ') failed: $o" }; $o }
function Q { & gcloud @args 2>$null }   # query, null when absent

function Write-Lf([string]$src, [string]$dst) {
  $t = [IO.File]::ReadAllText($src) -replace "`r`n", "`n"
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  [IO.File]::WriteAllText($dst, $t, [Text.UTF8Encoding]::new($false))
}

function Get-MetaFiles {
  $tmp = Join-Path $env:TEMP 'devcloud-mac-md'; New-Item -ItemType Directory -Force $tmp | Out-Null
  Write-Lf (Join-Path $here 'mac-host-startup.sh') (Join-Path $tmp 'startup.sh')
  Write-Lf (Join-Path $repo 'scripts\boot-mac.sh') (Join-Path $tmp 'boot-mac.sh')
  "startup-script=$tmp\startup.sh,boot-mac=$tmp\boot-mac.sh"
}
function Get-Meta { "mac-bucket=$Bucket,mac-prefix=$Prefix,mac-disk=$Disk,mac-idle-min=$IdleMin,mac-ram-mb=$RamMb,mac-cores=$Cores,mac-threads=$Threads" }

if ($Upload) {
  # Read the chain INSIDE WSL (ext4, not the 9P \\wsl.localhost bridge) and stream it with the
  # Windows gcloud through /mnt/c — gcloud.exe is on the WSL PATH (interop).
  $files = @('OpenCore/OpenCore.qcow2', 'OVMF_CODE_4M.fd', 'OVMF_VARS-1920x1080.fd', 'mac_hdd_ng.img', $Disk)
  foreach ($f in $files) {
    $exists = Q storage objects describe "gs://$Bucket/$Prefix/$f" --format='value(size)'
    if ($exists) { "skip $f (already in gs://$Bucket/$Prefix, $exists bytes)"; continue }
    $t0 = Get-Date
    & gcloud storage cp "\\wsl.localhost\$WslDistro$($WslVmDir -replace '/','\')\$($f -replace '/','\')" "gs://$Bucket/$Prefix/$f"
    if ($LASTEXITCODE) { throw "upload $f failed" }
    "uploaded $f in $([int]((Get-Date)-$t0).TotalSeconds)s"
  }
  exit 0
}

if ($Status) {
  & gcloud compute instances describe $Name --zone $Zone --project $Project --format='table(name,status,machineType.basename(),lastStartTimestamp,lastStopTimestamp)' 2>&1
  & gcloud compute disks describe $dataDisk --zone $Zone --project $Project --format='table(name,sizeGb,status,users.basename())' 2>&1
  & gcloud compute instances get-serial-port-output $Name --zone $Zone --project $Project 2>$null |
    Select-String '::mac-host' | Select-Object -Last 6 | ForEach-Object { $_.Line.Substring($_.Line.IndexOf('::mac-host')) }
  exit 0
}

if ($Provision) {
  # shared infra (idempotent)
  if (-not (Q storage buckets describe "gs://$Bucket" --format='value(name)')) {
    G storage buckets create "gs://$Bucket" --project $Project --location $region --uniform-bucket-level-access --public-access-prevention | Out-Null
  }
  if (-not (Q iam service-accounts describe $sa --project $Project --format='value(email)')) {
    G iam service-accounts create devcloud-mac --project $Project --display-name 'devcloud macOS host (owner only, DC-053)' | Out-Null; Start-Sleep 5
  }
  G storage buckets add-iam-policy-binding "gs://$Bucket" --member "serviceAccount:$sa" --role roles/storage.objectViewer | Out-Null
  G projects add-iam-policy-binding $Project --member "serviceAccount:$sa" --role roles/logging.logWriter --condition=None | Out-Null
  if (-not (Q iam roles describe devcloudMacSelfStop --project $Project --format='value(name)')) {
    G iam roles create devcloudMacSelfStop --project $Project --title 'devcloud mac self stop' --permissions 'compute.instances.stop,compute.instances.suspend,compute.instances.get' --stage GA | Out-Null
  }
  if (-not (Q compute firewall-rules describe devcloud-mac-allow-iap --project $Project --format='value(name)')) {
    G compute firewall-rules create devcloud-mac-allow-iap --project $Project --network default --direction INGRESS --source-ranges 35.235.240.0/20 --allow tcp:22 --target-tags devcloud-mac | Out-Null
  }
  if (-not (Q compute routers describe devcloud-nat-router --region $region --project $Project --format='value(name)')) {
    G compute routers create devcloud-nat-router --project $Project --region $region --network default | Out-Null
    G compute routers nats create devcloud-nat --project $Project --region $region --router devcloud-nat-router --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges | Out-Null
  }
  if (-not (Q compute disks describe $dataDisk --zone $Zone --project $Project --format='value(name)')) {
    G compute disks create $dataDisk --project $Project --zone $Zone --type hyperdisk-balanced --size "${DataGb}GB" --labels 'app=devcloud,role=mac-data' | Out-Null
    "data disk $dataDisk (${DataGb} GB)"
  }
  if (-not (Q compute instances describe $Name --zone $Zone --project $Project --format='value(name)')) {
    G compute instances create $Name --project $Project --zone $Zone --machine-type $Machine `
      --enable-nested-virtualization --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud `
      --boot-disk-type hyperdisk-balanced --boot-disk-size 50GB --boot-disk-auto-delete `
      --disk "name=$dataDisk,device-name=mac-data,mode=rw,auto-delete=no" `
      --no-address --tags devcloud-mac --service-account $sa --scopes cloud-platform `
      --metadata (Get-Meta) --metadata-from-file (Get-MetaFiles) `
      --labels 'app=devcloud,role=mac,owner=dragos' --shielded-vtpm --shielded-integrity-monitoring `
      --reservation-affinity none | Out-Null
    "created $Name ($Machine, $Zone, nested)"
  }
  G compute instances add-iam-policy-binding $Name --zone $Zone --project $Project --member "serviceAccount:$sa" --role $role | Out-Null
  # weekly data-disk snapshot, 4 kept
  if (-not (Q compute resource-policies describe devcloud-mac-weekly --region $region --project $Project --format='value(name)')) {
    G compute resource-policies create snapshot-schedule devcloud-mac-weekly --project $Project --region $region `
      --max-retention-days 28 --on-source-disk-delete keep-auto-snapshots --weekly-schedule sunday --start-time 03:00 --storage-location $region | Out-Null
  }
  & gcloud compute disks add-resource-policies $dataDisk --resource-policies devcloud-mac-weekly --zone $Zone --project $Project 2>$null | Out-Null
  "provisioned; first boot pulls the disk chain from gs://$Bucket/$Prefix (watch: -Status)"
  exit 0
}

if ($UpdateHost) {
  G compute instances add-metadata $Name --zone $Zone --project $Project --metadata (Get-Meta) --metadata-from-file (Get-MetaFiles) | Out-Null
  'metadata updated'
  if ((Q compute instances describe $Name --zone $Zone --project $Project --format='value(status)') -eq 'RUNNING') {
    G compute ssh $Name --zone $Zone --project $Project --tunnel-through-iap --command 'sudo google_metadata_script_runner startup' | Out-Null
    'startup script re-run'
  }
  exit 0
}

if ($Start) {
  $st = (Q compute instances describe $Name --zone $Zone --project $Project --format='value(status)')
  if ($st -eq 'SUSPENDED') { G compute instances resume $Name --zone $Zone --project $Project | Out-Null; "resumed $Name (macOS was left running) - now -Tunnel"; exit 0 }
  if ($st -eq 'RUNNING') { "$Name already running - -Tunnel"; exit 0 }
  G compute instances start $Name --zone $Zone --project $Project | Out-Null; "started $Name - macOS boots in ~1-2 min; then -Tunnel"; exit 0
}
if ($Stop) {
  # clean guest shutdown first (ACPI), then stop the host
  & gcloud compute ssh $Name --zone $Zone --project $Project --tunnel-through-iap --command 'sudo systemctl stop vmui-mac.service' 2>$null | Out-Null
  G compute instances stop $Name --zone $Zone --project $Project | Out-Null; "stopped $Name"; exit 0
}
if ($Snapshot) {
  $snap = "$dataDisk-$(Get-Date -Format yyyyMMdd-HHmm)"
  G compute snapshots create $snap --source-disk $dataDisk --source-disk-zone $Zone --project $Project --storage-location $region | Out-Null; "snapshot $snap"; exit 0
}
if ($Tunnel) {
  # Same local ports as the WSL VM, so mac-branch.ps1/sshpass/virt-viewer/VNC habits keep working.
  # Two hops, both verified on the spike (2026-10-17): gcloud start-iap-tunnel puts the host's sshd on
  # localhost:$IapPort, then Windows OpenSSH forwards each guest port (QEMU binds 127.0.0.1 only).
  # gcloud compute ssh on Windows drives PuTTY and an OpenSSH ProxyCommand with a quoted gcloud path
  # breaks in cmd ("Command name argument expected"), hence the explicit local port.
  # The gcloud key (~/.ssh/google_compute_engine) has inherited ACLs that OpenSSH rejects ("bad
  # permissions"), so a private copy with an owner-only ACL is used.
  $IapPort = 22220
  $key = "$HOME\.ssh\devcloud_mac_ed"
  if (-not (Test-Path $key)) {
    Copy-Item "$HOME\.ssh\google_compute_engine" $key
    & icacls $key /inheritance:r | Out-Null; & icacls $key /grant:r "$($env:USERNAME):(R)" | Out-Null
  }
  $iap = Start-Process gcloud.cmd -ArgumentList @('compute', 'start-iap-tunnel', $Name, '22', "--local-host-port=localhost:$IapPort", "--project=$Project", "--zone=$Zone") -PassThru -WindowStyle Hidden
  try {
    for ($i = 0; $i -lt 30; $i++) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1', $IapPort)).Close(); break } catch { Start-Sleep 1 } }
    'tunnel: ssh dragos@127.0.0.1 -p 10022 | VNC localhost:5900 | SPICE spice://localhost:5930 | Screen Sharing localhost:5901  (Ctrl+C to close)'
    & "$env:WINDIR\System32\OpenSSH\ssh.exe" -N -p $IapPort -i $key -o StrictHostKeyChecking=accept-new `
      -o "UserKnownHostsFile=$HOME\.ssh\devcloud_mac_known_hosts" -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes `
      -L 10022:127.0.0.1:10022 -L 5900:127.0.0.1:5900 -L 5930:127.0.0.1:5930 -L 5901:127.0.0.1:5901 "$($env:USERNAME.ToLower())@127.0.0.1"
  } finally { Stop-Process -Id $iap.Id -Force -ErrorAction SilentlyContinue }
  exit 0
}
if ($Delete) {
  $ans = Read-Host "Delete VM $Name? The data disk $dataDisk is KEPT. Type the VM name to confirm"
  if ($ans -ne $Name) { 'aborted'; exit 1 }
  G compute instances delete $Name --zone $Zone --project $Project --keep-disks data --quiet | Out-Null; "deleted $Name (kept $dataDisk)"; exit 0
}
Get-Help $PSCommandPath
