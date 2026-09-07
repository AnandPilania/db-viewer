import net from "node:net";
import { Client } from "ssh2";
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
export function openSshTunnel(config: SshTunnelConfig, targetHost: string, targetPort: number): Promise<TunnelHandle> {
    return new Promise((resolve, reject) => {
        const ssh = new Client();

        ssh.on("ready", () => {
            const server = net.createServer((socket) => {
                ssh.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, targetHost, targetPort, (err, stream) => {
                    if (err) {
                        socket.destroy();
                        return;
                    }
                    socket.pipe(stream).pipe(socket);
                    socket.on("error", () => stream.destroy());
                    stream.on("error", () => socket.destroy());
                });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const localPort = (server.address() as net.AddressInfo).port;
                resolve({
                    localPort,
                    close: () => {
                        server.close();
                        ssh.end();
                    },
                });
            });
        });

        ssh.on("error", reject);
        ssh.connect({
            host: config.host,
            port: config.port ?? 22,
            username: config.username,
            privateKey: config.privateKey,
            passphrase: config.passphrase,
            password: config.password,
            readyTimeout: 10_000,
        });
    });
}
