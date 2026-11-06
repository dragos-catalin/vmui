#!/usr/bin/env bash
# Package a streamOptimized VMDK as an OVA (OVF 1.0: VirtualBox, VMware Workstation/ESXi).
#   bash ova.sh <disk1.vmdk> <version> <out.ova>
set -euo pipefail
VMDK="$1"; VERSION="$2"; OVA="$3"
D="$(mktemp -d)"
NAME="vatra-hub-x86-$VERSION"
cp "$VMDK" "$D/$NAME-disk1.vmdk"
SIZE=$(stat -c %s "$D/$NAME-disk1.vmdk")
CAP=$(qemu-img info --output=json "$VMDK" | python3 -c 'import json,sys;print(json.load(sys.stdin)["virtual-size"])')
cat > "$D/$NAME.ovf" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
  xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
  xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData">
  <References><File ovf:id="file1" ovf:href="$NAME-disk1.vmdk" ovf:size="$SIZE"/></References>
  <DiskSection><Info>Virtual disk</Info>
    <Disk ovf:diskId="vmdisk1" ovf:fileRef="file1" ovf:capacity="$CAP" ovf:capacityAllocationUnits="byte"
      ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
  </DiskSection>
  <NetworkSection><Info>Network</Info><Network ovf:name="bridged"><Description>Home LAN (bridged, so phones can find the hub)</Description></Network></NetworkSection>
  <VirtualSystem ovf:id="$NAME">
    <Info>Vatra home hub $VERSION</Info>
    <Name>Vatra hub</Name>
    <OperatingSystemSection ovf:id="96"><Info>Debian 64-bit</Info></OperatingSystemSection>
    <VirtualHardwareSection><Info>2 vCPU, 4 GB RAM, 16 GB disk</Info>
      <System><vssd:ElementName>Virtual Hardware Family</vssd:ElementName><vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>$NAME</vssd:VirtualSystemIdentifier><vssd:VirtualSystemType>vmx-14 virtualbox-2.2</vssd:VirtualSystemType></System>
      <Item><rasd:AllocationUnits>hertz * 10^6</rasd:AllocationUnits><rasd:ElementName>2 vCPU</rasd:ElementName><rasd:InstanceID>1</rasd:InstanceID><rasd:ResourceType>3</rasd:ResourceType><rasd:VirtualQuantity>2</rasd:VirtualQuantity></Item>
      <Item><rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits><rasd:ElementName>4096 MB</rasd:ElementName><rasd:InstanceID>2</rasd:InstanceID><rasd:ResourceType>4</rasd:ResourceType><rasd:VirtualQuantity>4096</rasd:VirtualQuantity></Item>
      <Item><rasd:Address>0</rasd:Address><rasd:ElementName>SATA</rasd:ElementName><rasd:InstanceID>3</rasd:InstanceID><rasd:ResourceSubType>AHCI</rasd:ResourceSubType><rasd:ResourceType>20</rasd:ResourceType></Item>
      <Item><rasd:AddressOnParent>0</rasd:AddressOnParent><rasd:ElementName>disk1</rasd:ElementName><rasd:HostResource>ovf:/disk/vmdisk1</rasd:HostResource><rasd:InstanceID>4</rasd:InstanceID><rasd:Parent>3</rasd:Parent><rasd:ResourceType>17</rasd:ResourceType></Item>
      <Item><rasd:AutomaticAllocation>true</rasd:AutomaticAllocation><rasd:Connection>bridged</rasd:Connection><rasd:ElementName>Ethernet</rasd:ElementName><rasd:InstanceID>5</rasd:InstanceID><rasd:ResourceSubType>E1000</rasd:ResourceSubType><rasd:ResourceType>10</rasd:ResourceType></Item>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
EOF
(cd "$D" && sha256sum "$NAME.ovf" "$NAME-disk1.vmdk" | awk '{print "SHA256(" $2 ")= " $1}' > "$NAME.mf")
# OVF order: descriptor first, then manifest, then disks
tar -C "$D" -cf "$OVA" --format=ustar "$NAME.ovf" "$NAME.mf" "$NAME-disk1.vmdk"
rm -rf "$D"
echo "ova $(du -h "$OVA" | cut -f1)"
