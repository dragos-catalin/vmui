import "server-only";
import {
  InstancesClient,
  DisksClient,
  SnapshotsClient,
  NetworksClient,
  SubnetworksClient,
  FirewallsClient,
  ImagesClient,
} from "@google-cloud/compute";
import { Storage } from "@google-cloud/storage";
import { DNS } from "@google-cloud/dns";
import { JWT } from "google-auth-library";
import type {
  CloudProvider,
  ConnectionInfo,
  CreateInstanceInput,
  InstanceLogChunk,
  InstanceTemplate,
  MetricSeries,
  MetricsHistory,
  NormalizedInstance,
  NormalizedResource,
  NormalizedState,
  Platform,
  ProviderAccountInfo,
  ResourceKind,
} from "./types";

export interface GcpCredentials {
  /** Service-account JSON key — same shape Google emits from IAM. */
  keyJson: {
    project_id: string;
    client_email: string;
    private_key: string;
    [k: string]: unknown;
  };
  /** Default zone, e.g. "us-central1-a". */
  defaultZone?: string;
}

const TEMPLATES: InstanceTemplate[] = [
  {
    id: "gcp-debian-12",
    label: "Debian 12",
    platform: "linux",
    description: "Standard Linux instance using Google's Debian 12 image.",
    recommendedTypes: ["e2-micro", "e2-small", "e2-medium", "e2-standard-2"],
  },
  {
    id: "gcp-windows-2022",
    label: "Windows Server 2022",
    platform: "windows",
    description: "Windows Server 2022 Datacenter, RDP enabled.",
    recommendedTypes: ["e2-standard-2", "e2-standard-4"],
    notes: ["RDP on port 3389. Set the Windows password via gcloud or vmui's Connect dialog."],
  },
];

/** Map GCP status values to normalized state. */
function mapStatus(s: string | null | undefined): NormalizedState {
  switch (s) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STAGING":
      return "pending";
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    case "TERMINATED":
    case "STOPPED":
    case "SUSPENDED":
      return "stopped";
    default:
      return "unknown";
  }
}

export function detectPlatform(
  machineType: string | null | undefined,
  name: string | null | undefined,
  labels?: Record<string, string> | null,
): Platform {
  // The devcloud macOS host (infra/devcloud/mac, DC-053) is an Ubuntu VM
  // running OSX-KVM; its label says what the user actually works with.
  if (labels?.role === "mac") return "macos";
  // GCP doesn't expose OS family on the instance directly; rely on disk
  // licenses. As a heuristic, "windows" in the name is good enough; real
  // detection happens by inspecting boot disk source image (out of scope
  // for this read-only first cut).
  const n = (name ?? "").toLowerCase();
  if (n.includes("win")) return "windows";
  return "linux";
}

/**
 * Connection info for the devcloud macOS host: no external IP, everything
 * (SSH to the guest, VNC, SPICE, Screen Sharing) goes through one IAP SSH
 * tunnel that maps the SAME localhost ports as the local WSL2 VM.
 */
export function macIapConnectionInfo(name: string, zone: string, project: string): ConnectionInfo {
  return {
    protocol: "vnc",
    host: "127.0.0.1",
    port: 5900,
    username: "dragos",
    vncUrl: "vnc://127.0.0.1:5900",
    sshCommand: "ssh dragos@127.0.0.1 -p 10022",
    notes: [
      "macOS (OSX-KVM) on a GCE nested-KVM host, no external IP. Open the IAP tunnel first:",
      `pwsh -NoProfile -File infra/devcloud/mac/mac-gce.ps1 -Name ${name} -Zone ${zone} -Project ${project} -Tunnel`,
      "Then: SSH 127.0.0.1:10022, VNC 127.0.0.1:5900, SPICE spice://127.0.0.1:5930, Screen Sharing 127.0.0.1:5901.",
      "The host stops itself after 15 min without a session; start it from vmui or with -Start.",
    ],
  };
}

/**
 * GCP instance ids look like "{zone}/{name}" so we can address them with
 * the same "short id" convention as Azure.
 */
function vmIdOf(zone: string, name: string): string {
  return `${zone}/${name}`;
}

function parseId(id: string): { zone: string; name: string } {
  const slash = id.indexOf("/");
  if (slash < 0) throw new Error(`Bad GCP VM id: ${id}`);
  return { zone: id.slice(0, slash), name: id.slice(slash + 1) };
}

export class GcpProvider implements CloudProvider {
  readonly id = "gcp" as const;
  private readonly creds: GcpCredentials;

  constructor(creds: GcpCredentials) {
    this.creds = creds;
  }

  private clientOptions() {
    return {
      projectId: this.creds.keyJson.project_id,
      credentials: {
        client_email: this.creds.keyJson.client_email,
        private_key: this.creds.keyJson.private_key,
      },
    };
  }

  private instances(): InstancesClient {
    return new InstancesClient(this.clientOptions());
  }

  private get project(): string {
    return this.creds.keyJson.project_id;
  }

  async verify(): Promise<ProviderAccountInfo> {
    // A cheap way to validate is to issue aggregatedList and consume one item.
    const c = this.instances();
    const it = c.aggregatedListAsync({ project: this.project, maxResults: 1 });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of it) {
      break;
    }
    return {
      accountId: this.project,
      label: `GCP project ${this.project} (${this.creds.keyJson.client_email})`,
    };
  }

  async listRegions(): Promise<string[]> {
    // We expose zones as "regions" since GCP places VMs at zone granularity.
    // Using a small static list of common zones avoids a billable list call.
    return [
      "us-central1-a",
      "us-east1-b",
      "us-west1-a",
      "europe-west1-b",
      "europe-west4-a",
      "asia-northeast1-a",
    ];
  }

  async listInstances(_region: string): Promise<NormalizedInstance[]> {
    const c = this.instances();
    const out: NormalizedInstance[] = [];
    for await (const [zoneRaw, group] of c.aggregatedListAsync({ project: this.project })) {
      // zoneRaw looks like "zones/us-central1-a"
      const zone = zoneRaw.startsWith("zones/") ? zoneRaw.slice(6) : zoneRaw;
      for (const inst of group.instances ?? []) {
        if (!inst.name) continue;
        const machineType = inst.machineType?.split("/").pop() ?? null;
        const networkIface = inst.networkInterfaces?.[0];
        const accessCfg = networkIface?.accessConfigs?.[0];
        out.push({
          providerInstanceId: vmIdOf(zone, inst.name),
          region: zone,
          name: inst.name ?? null,
          state: mapStatus(inst.status ?? null),
          platform: detectPlatform(machineType, inst.name ?? null, (inst.labels as Record<string, string> | null | undefined) ?? null),
          instanceType: machineType,
          publicIp: accessCfg?.natIP ?? null,
          publicDns: null,
          privateIp: networkIface?.networkIP ?? null,
          keyName: null,
          raw: inst,
        });
      }
    }
    return out;
  }

  async getInstance(_region: string, id: string): Promise<NormalizedInstance | null> {
    const list = await this.listInstances(_region);
    return list.find((i) => i.providerInstanceId === id) ?? null;
  }

  async startInstance(_region: string, id: string): Promise<void> {
    const { zone, name } = parseId(id);
    await this.instances().start({ project: this.project, zone, instance: name });
  }
  async stopInstance(_region: string, id: string): Promise<void> {
    const { zone, name } = parseId(id);
    await this.instances().stop({ project: this.project, zone, instance: name });
  }
  async rebootInstance(_region: string, id: string): Promise<void> {
    const { zone, name } = parseId(id);
    await this.instances().reset({ project: this.project, zone, instance: name });
  }
  async terminateInstance(_region: string, id: string): Promise<void> {
    const { zone, name } = parseId(id);
    await this.instances().delete({ project: this.project, zone, instance: name });
  }

  async applyTags(_region: string, id: string, tags: Record<string, string>): Promise<void> {
    const { zone, name } = parseId(id);
    const c = this.instances();
    const [info] = await c.get({ project: this.project, zone, instance: name });
    const fingerprint = info.labelFingerprint ?? "";
    // GCP labels: lowercase, [-a-z0-9_], <=63 chars.
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(tags)) {
      const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63);
      const val = v.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 63);
      labels[key] = val;
    }
    await c.setLabels({
      project: this.project,
      zone,
      instance: name,
      instancesSetLabelsRequestResource: { labels, labelFingerprint: fingerprint },
    });
  }

  async createSnapshot(
    _region: string,
    id: string,
    label: string,
  ): Promise<{ snapshotId: string; note?: string }> {
    const { zone, name } = parseId(id);
    const inst = this.instances();
    const [info] = await inst.get({ project: this.project, zone, instance: name });
    // Boot disk first; fall back to first attached disk.
    const bootAttachment =
      info.disks?.find((d) => d.boot) ?? info.disks?.[0] ?? null;
    const sourceUrl = bootAttachment?.source ?? "";
    if (!sourceUrl) throw new Error("Instance has no attached boot disk to snapshot.");
    // sourceUrl is like .../zones/{zone}/disks/{diskName}
    const parts = sourceUrl.split("/");
    const diskName = parts[parts.length - 1] ?? "";
    if (!diskName) throw new Error(`Could not parse disk name from ${sourceUrl}`);
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
    const snapName = `${name}-${safeLabel}-${Date.now()}`.toLowerCase().slice(0, 60);
    const disks = new DisksClient(this.clientOptions());
    await disks.createSnapshot({
      project: this.project,
      zone,
      disk: diskName,
      snapshotResource: {
        name: snapName,
        description: `vmui snapshot of ${name} (${label})`,
        sourceDisk: sourceUrl,
      },
    });
    return { snapshotId: snapName, note: `Snapshot of boot disk ${diskName}.` };
  }

  async deleteSnapshot(_region: string, snapshotId: string): Promise<void> {
    const c = new SnapshotsClient(this.clientOptions());
    await c.delete({ project: this.project, snapshot: snapshotId });
  }

  private async monitoringToken(): Promise<string> {
    const auth = new JWT({
      email: this.creds.keyJson.client_email,
      key: this.creds.keyJson.private_key,
      scopes: [
        "https://www.googleapis.com/auth/monitoring.read",
        "https://www.googleapis.com/auth/compute.readonly",
      ],
    });
    const t = await auth.getAccessToken();
    if (!t.token) throw new Error("Failed to get GCP access token");
    return t.token;
  }

  async getMetricsHistory(
    _region: string,
    id: string,
    rangeMinutes: number,
  ): Promise<MetricsHistory> {
    const { zone, name } = parseId(id);
    const c = this.instances();
    const [info] = await c.get({ project: this.project, zone, instance: name });
    const numericId = String(info.id ?? "");
    const token = await this.monitoringToken();
    const end = new Date();
    const start = new Date(end.getTime() - rangeMinutes * 60_000);
    const stepSeconds = rangeMinutes <= 60 ? 60 : rangeMinutes <= 6 * 60 ? 300 : 900;

    const fetchSeries = async (
      metric: string,
      filterExtra = "",
    ): Promise<{ t: number; v: number | null }[]> => {
      const filter =
        `metric.type = "${metric}" AND ` +
        `resource.type = "gce_instance" AND ` +
        `resource.labels.instance_id = "${numericId}"` +
        (filterExtra ? ` AND ${filterExtra}` : "");
      const params = new URLSearchParams({
        filter,
        "interval.startTime": start.toISOString(),
        "interval.endTime": end.toISOString(),
        "aggregation.alignmentPeriod": `${stepSeconds}s`,
        "aggregation.perSeriesAligner": "ALIGN_MEAN",
      });
      const url = `https://monitoring.googleapis.com/v3/projects/${this.project}/timeSeries?${params}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        timeSeries?: Array<{
          points?: Array<{
            interval: { startTime: string; endTime: string };
            value?: { doubleValue?: number; int64Value?: string };
          }>;
        }>;
      };
      const points = body.timeSeries?.[0]?.points ?? [];
      return points
        .map((p) => ({
          t: new Date(p.interval.endTime).getTime(),
          v:
            typeof p.value?.doubleValue === "number"
              ? p.value.doubleValue
              : p.value?.int64Value
                ? Number(p.value.int64Value)
                : null,
        }))
        .sort((a, b) => a.t - b.t);
    };

    const [cpu, netRx, netTx, dRead, dWrite] = await Promise.all([
      fetchSeries("compute.googleapis.com/instance/cpu/utilization"),
      fetchSeries("compute.googleapis.com/instance/network/received_bytes_count"),
      fetchSeries("compute.googleapis.com/instance/network/sent_bytes_count"),
      fetchSeries("compute.googleapis.com/instance/disk/read_bytes_count"),
      fetchSeries("compute.googleapis.com/instance/disk/write_bytes_count"),
    ]);

    // CPU is fraction 0..1 — convert to percent. Network/Disk are total bytes
    // over the alignment window — divide by step to get bytes/sec.
    const toPct = (pts: { t: number; v: number | null }[]) =>
      pts.map((p) => ({ t: p.t, v: p.v == null ? null : p.v * 100 }));
    const toBps = (pts: { t: number; v: number | null }[]) =>
      pts.map((p) => ({ t: p.t, v: p.v == null ? null : p.v / stepSeconds }));

    const series: MetricSeries[] = [
      { id: "cpuPercent", label: "CPU", unit: "percent", points: toPct(cpu) },
      { id: "netRxBps", label: "Network in", unit: "bps", points: toBps(netRx) },
      { id: "netTxBps", label: "Network out", unit: "bps", points: toBps(netTx) },
      { id: "diskReadBps", label: "Disk read", unit: "bps", points: toBps(dRead) },
      { id: "diskWriteBps", label: "Disk write", unit: "bps", points: toBps(dWrite) },
    ];
    return {
      startedAt: start.getTime(),
      endedAt: end.getTime(),
      stepSeconds,
      series,
      source: `Cloud Monitoring · ${stepSeconds}s buckets`,
    };
  }

  async getMetrics(region: string, id: string) {
    const h = await this.getMetricsHistory(region, id, 30);
    const last = (sid: string) => {
      const s = h.series.find((x) => x.id === sid);
      const pts = (s?.points ?? []).filter((p) => p.v != null);
      const v = pts[pts.length - 1]?.v;
      return typeof v === "number" ? v : undefined;
    };
    return {
      sampledAt: Date.now(),
      running: true,
      cpuPercent: last("cpuPercent"),
      netRxBps: last("netRxBps"),
      netTxBps: last("netTxBps"),
      diskReadBps: last("diskReadBps"),
      diskWriteBps: last("diskWriteBps"),
      note: h.source,
    };
  }

  async getInstanceLogs(_region: string, id: string): Promise<InstanceLogChunk> {
    const { zone, name } = parseId(id);
    const c = this.instances();
    const [out] = await c.getSerialPortOutput({
      project: this.project,
      zone,
      instance: name,
      port: 1,
    });
    const text = out.contents ?? "";
    return {
      text,
      fetchedAt: Date.now(),
      source: "GCE serial port 1",
      truncated: false,
    };
  }

  async createInstance(input: CreateInstanceInput): Promise<NormalizedInstance> {
    const zone = input.region;
    const project = this.project;
    // Map our template ids to Google's image projects/families.
    const map: Record<string, { project: string; family: string; platform: Platform }> = {
      "gcp-debian-12": { project: "debian-cloud", family: "debian-12", platform: "linux" },
      "gcp-ubuntu-22.04": { project: "ubuntu-os-cloud", family: "ubuntu-2204-lts", platform: "linux" },
      "gcp-windows-2022": {
        project: "windows-cloud",
        family: "windows-2022",
        platform: "windows",
      },
    };
    const tpl =
      map[input.template] ??
      map[`gcp-${input.template}`] ??
      map["gcp-debian-12"]!;

    const machineType = `zones/${zone}/machineTypes/${input.instanceType}`;
    const sourceImageFamily = `projects/${tpl.project}/global/images/family/${tpl.family}`;
    const sourceSnapshot = input.fromSnapshotId
      ? input.fromSnapshotId.startsWith("projects/")
        ? input.fromSnapshotId
        : `projects/${project}/global/snapshots/${input.fromSnapshotId}`
      : null;

    const metadata: { key: string; value: string }[] = [];
    if (input.sshPublicKey && tpl.platform === "linux") {
      const user = input.username ?? "ubuntu";
      metadata.push({ key: "ssh-keys", value: `${user}:${input.sshPublicKey}` });
    }
    if (input.userData) {
      metadata.push({
        key: tpl.platform === "windows" ? "sysprep-specialize-script-ps1" : "startup-script",
        value: input.userData,
      });
    }

    const c = this.instances();
    const [op] = await c.insert({
      project,
      zone,
      instanceResource: {
        name: input.name,
        machineType,
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: sourceSnapshot
              ? { sourceSnapshot, diskSizeGb: 20 }
              : { sourceImage: sourceImageFamily, diskSizeGb: 20 },
          },
        ],
        networkInterfaces: [
          {
            network: `projects/${project}/global/networks/default`,
            accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }],
          },
        ],
        metadata: { items: metadata },
        labels: { "vmui-managed": "true" },
      },
    });
    // Best-effort: wait briefly for the operation; otherwise return what we have.
    void op;
    const inst = await this.getInstance(zone, vmIdOf(zone, input.name));
    if (!inst) {
      return {
        providerInstanceId: vmIdOf(zone, input.name),
        region: zone,
        name: input.name,
        state: "pending",
        platform: tpl.platform,
        instanceType: input.instanceType,
        publicIp: null,
        publicDns: null,
        privateIp: null,
        keyName: null,
        raw: { pending: true },
      };
    }
    return inst;
  }

  async getConnectionInfo(region: string, id: string): Promise<ConnectionInfo> {
    const vm = await this.getInstance(region, id);
    if (!vm) throw new Error("VM not found");
    if (vm.platform === "macos" && !vm.publicIp) {
      return macIapConnectionInfo(vm.name ?? parseId(id).name, vm.region, this.project);
    }
    const host = vm.publicIp ?? vm.privateIp ?? "";
    if (!host) {
      return {
        protocol: "ssh",
        host: "",
        port: 22,
        username: "—",
        notes: ["No external IP on this VM. Add one or use IAP tunnelling via gcloud."],
      };
    }
    if (vm.platform === "windows") {
      const fileContent = [
        `full address:s:${host}:3389`,
        "prompt for credentials:i:1",
        "administrative session:i:1",
      ].join("\r\n");
      return {
        protocol: "rdp",
        host,
        port: 3389,
        username: "Administrator",
        fileContent,
        fileName: `${vm.name ?? id}.rdp`,
        fileMime: "application/x-rdp",
        notes: [
          "Generate a Windows password with: gcloud compute reset-windows-password",
          `gcloud compute reset-windows-password ${vm.name} --zone=${vm.region}`,
        ],
      };
    }
    return {
      protocol: "ssh",
      host,
      port: 22,
      username: "your-gcp-username",
      sshCommand: `gcloud compute ssh ${vm.name} --zone=${vm.region}`,
      notes: [
        "GCP rotates SSH keys via OS Login or metadata. Easiest: use gcloud compute ssh.",
      ],
    };
  }

  async listInstanceTemplates(): Promise<InstanceTemplate[]> {
    return TEMPLATES;
  }

  async listResources(region: string, kind: ResourceKind): Promise<NormalizedResource[]> {
    if (kind === "volume") return this.listDisks(region);
    if (kind === "snapshot") return this.listSnapshots();
    if (kind === "vpc") return this.listVpcs();
    if (kind === "subnet") return this.listSubnets(region);
    if (kind === "security-group") return this.listFirewalls();
    if (kind === "image") return this.listImages();
    if (kind === "bucket") return this.listBuckets(region);
    if (kind === "database") return this.listCloudSql(region);
    if (kind === "dns-zone") return this.listDnsZones(region);
    return [];
  }

  /** Maps a GCP zone like "europe-west1-b" to its parent region "europe-west1". */
  private parentRegion(zone: string): string {
    const lastDash = zone.lastIndexOf("-");
    return lastDash > 0 ? zone.slice(0, lastDash) : zone;
  }

  private async listDisks(region: string): Promise<NormalizedResource[]> {
    const c = new DisksClient(this.clientOptions());
    const out: NormalizedResource[] = [];
    for await (const [zoneRaw, group] of c.aggregatedListAsync({ project: this.project })) {
      const zone = zoneRaw.startsWith("zones/") ? zoneRaw.slice(6) : zoneRaw;
      // GCP "region" in our sync is actually a zone — match exact zone OR parent region.
      if (zone !== region && this.parentRegion(zone) !== region) continue;
      for (const d of group.disks ?? []) {
        if (!d.name) continue;
        out.push({
          externalId: d.id ? String(d.id) : `${zone}/${d.name}`,
          region: zone,
          kind: "volume",
          name: d.name ?? null,
          status: d.status ?? null,
          sizeBytes: d.sizeGb ? Number(d.sizeGb) * 1024 ** 3 : null,
          attachedTo: d.users?.[0] ?? null,
          raw: d,
        });
      }
    }
    return out;
  }

  private async listSnapshots(): Promise<NormalizedResource[]> {
    const c = new SnapshotsClient(this.clientOptions());
    const out: NormalizedResource[] = [];
    for await (const s of c.listAsync({ project: this.project })) {
      out.push({
        externalId: s.id ? String(s.id) : s.name ?? "",
        region: "global",
        kind: "snapshot",
        name: s.name ?? null,
        status: s.status ?? null,
        sizeBytes: s.diskSizeGb ? Number(s.diskSizeGb) * 1024 ** 3 : null,
        raw: s,
      });
    }
    return out;
  }

  private async listVpcs(): Promise<NormalizedResource[]> {
    const c = new NetworksClient(this.clientOptions());
    const out: NormalizedResource[] = [];
    for await (const n of c.listAsync({ project: this.project })) {
      out.push({
        externalId: n.id ? String(n.id) : n.name ?? "",
        region: "global",
        kind: "vpc",
        name: n.name ?? null,
        status: n.autoCreateSubnetworks ? "auto" : "custom",
        raw: n,
      });
    }
    return out;
  }

  private async listSubnets(region: string): Promise<NormalizedResource[]> {
    const c = new SubnetworksClient(this.clientOptions());
    const parent = this.parentRegion(region);
    const out: NormalizedResource[] = [];
    try {
      for await (const s of c.listAsync({ project: this.project, region: parent })) {
        out.push({
          externalId: s.id ? String(s.id) : `${parent}/${s.name ?? ""}`,
          region: parent,
          kind: "subnet",
          name: s.name ?? null,
          status: s.ipCidrRange ?? null,
          raw: s,
        });
      }
    } catch {
      // region may not be valid — return empty silently
    }
    return out;
  }

  private async listFirewalls(): Promise<NormalizedResource[]> {
    const c = new FirewallsClient(this.clientOptions());
    const out: NormalizedResource[] = [];
    for await (const f of c.listAsync({ project: this.project })) {
      out.push({
        externalId: f.id ? String(f.id) : f.name ?? "",
        region: "global",
        kind: "security-group",
        name: f.name ?? null,
        status: f.disabled ? "disabled" : "enabled",
        raw: f,
      });
    }
    return out;
  }

  private async listImages(): Promise<NormalizedResource[]> {
    const c = new ImagesClient(this.clientOptions());
    const out: NormalizedResource[] = [];
    // Only project-owned images; public images are too large to enumerate here.
    for await (const img of c.listAsync({ project: this.project })) {
      out.push({
        externalId: img.id ? String(img.id) : img.name ?? "",
        region: "global",
        kind: "image",
        name: img.name ?? null,
        status: img.status ?? null,
        sizeBytes: img.archiveSizeBytes ? Number(img.archiveSizeBytes) : null,
        raw: img,
      });
    }
    return out;
  }

  private async listBuckets(region: string): Promise<NormalizedResource[]> {
    // Buckets are global in GCS but have a `location` (e.g. "US", "EU",
    // "us-central1"). Only emit on the parent region's first zone to avoid
    // multi-region duplicates.
    if (region !== this.creds.defaultZone) return [];
    const storage = new Storage(this.clientOptions());
    const [buckets] = await storage.getBuckets();
    return buckets.map((b) => ({
      externalId: b.id ?? b.name,
      region,
      kind: "bucket" as const,
      name: b.name,
      status: (b.metadata.location as string | undefined) ?? null,
      raw: b.metadata,
    }));
  }

  private async listDnsZones(region: string): Promise<NormalizedResource[]> {
    if (region !== this.creds.defaultZone) return [];
    const dns = new DNS(this.clientOptions());
    const [zones] = await dns.getZones();
    return zones.map((z) => ({
      externalId: z.id ?? z.name,
      region,
      kind: "dns-zone" as const,
      name: z.name,
      status: (z.metadata?.dnsName as string | undefined) ?? null,
      raw: z.metadata,
    }));
  }

  private async listCloudSql(region: string): Promise<NormalizedResource[]> {
    if (region !== this.creds.defaultZone) return [];
    const auth = new JWT({
      email: this.creds.keyJson.client_email,
      key: this.creds.keyJson.private_key,
      scopes: ["https://www.googleapis.com/auth/sqlservice.admin"],
    });
    const token = await auth.getAccessToken();
    if (!token.token) return [];
    const url = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${this.project}/instances`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
    const items = body.items ?? [];
    return items.map((i) => {
      const name = (i.name as string | undefined) ?? "";
      const reg = (i.region as string | undefined) ?? "";
      const settings = (i.settings as Record<string, unknown> | undefined) ?? {};
      const dbVersion = (i.databaseVersion as string | undefined) ?? null;
      return {
        externalId: (i.selfLink as string | undefined) ?? `${this.project}/${name}`,
        region: reg,
        kind: "database" as const,
        name,
        status: (i.state as string | undefined) ?? null,
        sizeBytes:
          settings.dataDiskSizeGb != null ? Number(settings.dataDiskSizeGb) * 1024 ** 3 : null,
        raw: { databaseVersion: dbVersion, settings },
      };
    });
  }
}
