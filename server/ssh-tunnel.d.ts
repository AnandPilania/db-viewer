import type { SshTunnelConfig } from "@pilaniaanand/driver-interface";
export interface TunnelHandle {
    localPort: number;
    close: () => void;
}
/**
 * Opens a local TCP listener that forwards every connection through an SSH
 * server to `targetHost:targetPort` as seen from that server's side — the
 * same thing `ssh -L <local>:<targetHost>:<targetPort> user@host` does on
 * the command line. This is what lets a driver reach a database sitting in
 * a private subnet behind a bastion, by connecting to `127.0.0.1:<localPort>`
 * instead of the real host.
 */
export declare function openSshTunnel(config: SshTunnelConfig, targetHost: string, targetPort: number): Promise<TunnelHandle>;
