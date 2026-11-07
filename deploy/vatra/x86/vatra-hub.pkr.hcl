# Vatra hub x86-64 virtual appliance (P5-05): Debian 13 genericcloud + Docker + the baked stack.
# Outputs a qcow2 (Proxmox / KVM / Unraid) that build.sh converts to an OVA (VirtualBox, VMware)
# and a VHDX (Hyper-V).
#   packer init deploy/vatra/x86 && packer build -var bake_dir=/srv/vatra-bake -var version=0.4.0 deploy/vatra/x86
packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = "~> 1.1.8"
    }
  }
}

variable "version" { type = string }
# build.sh stages deploy/vatra + pi/avahi-vmui.service + the baked stack in one tarball
variable "payload" { type = string }
# build.sh writes a throwaway key pair + cloud-init seed here; nothing of it stays in the image
variable "seed_dir" { type = string }
variable "base_url" {
  type    = string
  default = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
}
variable "base_checksum" {
  type    = string
  default = "file:https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS"
}
variable "accel" {
  type    = string
  default = "kvm"
}
# 1 = A/B image (P5-04): provision.sh also runs deploy/vatra/os/rootfs-ab.sh; ab-image.sh then
# turns the qcow2's rootfs into EROFS slots + data partition + systemd-boot ESP
variable "ab" {
  type    = string
  default = "0"
}

source "qemu" "vatra" {
  iso_url          = var.base_url
  iso_checksum     = var.base_checksum
  disk_image       = true
  disk_size        = "16G"
  disk_compression = true
  format           = "qcow2"
  accelerator      = var.accel
  cpus             = 4
  memory           = 4096
  headless         = true
  net_device       = "virtio-net"
  disk_interface   = "virtio"
  output_directory = "output"
  vm_name          = "vatra-hub-x86-${var.version}.qcow2"
  # build-time login only: cloud-init seeds a throwaway key, removed with cloud-init at the end
  cd_files = ["${var.seed_dir}/meta-data", "${var.seed_dir}/user-data"]
  cd_label = "cidata"
  ssh_username         = "packer"
  ssh_private_key_file = "${var.seed_dir}/packer_key"
  ssh_timeout          = "15m"
  # the build user goes away with the very last command
  shutdown_command = "sudo bash -c 'rm -f /etc/sudoers.d/packer; userdel -rf packer; shutdown -P now'"
}

build {
  sources = ["source.qemu.vatra"]

  provisioner "file" {
    source      = var.payload
    destination = "/tmp/vatra-payload.tar"
  }
  provisioner "shell" {
    # environment_vars reach the script only through {{ .Vars }}
    execute_command  = "sudo -E env {{ .Vars }} bash '{{ .Path }}'"
    environment_vars = ["VATRA_AB=${var.ab}", "VATRA_VERSION=${var.version}"]
    script           = "${path.root}/provision.sh"
  }
}
