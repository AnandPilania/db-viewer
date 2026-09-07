import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface Props {
  onConnected: (connectionId: string) => void;
}

type DriverKey = "sqlite" | "postgres" | "mysql" | "mongodb" | "redis" | "clickhouse";
type SshAuthMethod = "key" | "password";

const DEFAULT_PORTS: Record<DriverKey, number> = {
  sqlite: 0,
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
};

const DRIVER_LABELS: Record<DriverKey, string> = {
  sqlite: "SQLite",
  postgres: "Postgres",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  clickhouse: "ClickHouse",
};

const textareaClass =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function ConnectionForm({ onConnected }: Props) {
  const [driver, setDriver] = useState<DriverKey>("sqlite");
  const [filePath, setFilePath] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(String(DEFAULT_PORTS.postgres));
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  // TLS client-cert auth — for a database that requires (or accepts) certificate-based auth directly.
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslRejectUnauthorized, setSslRejectUnauthorized] = useState(true);
  const [sslCa, setSslCa] = useState("");
  const [sslCert, setSslCert] = useState("");
  const [sslKey, setSslKey] = useState("");

  // SSH tunnel — for a database reachable only through a bastion/jump host (e.g. AWS RDS in a private subnet).
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("key");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshPassword, setSshPassword] = useState("");

  const queryClient = useQueryClient();

  function selectDriver(d: DriverKey) {
    setDriver(d);
    setPort(String(DEFAULT_PORTS[d]));
  }

  const mutation = useMutation({
    mutationFn: () =>
      driver === "sqlite"
        ? api.createConnection({ driver, filePath, readOnly: readOnly || undefined })
        : api.createConnection({
            driver,
            host,
            port: Number(port),
            database: database || undefined,
            username: username || undefined,
            password: password || undefined,
            readOnly: readOnly || undefined,
            ssl: sslEnabled
              ? {
                  enabled: true,
                  rejectUnauthorized: sslRejectUnauthorized,
                  ca: sslCa || undefined,
                  cert: sslCert || undefined,
                  key: sslKey || undefined,
                }
              : undefined,
            sshTunnel: sshEnabled
              ? {
                  enabled: true,
                  host: sshHost,
                  port: Number(sshPort) || 22,
                  username: sshUsername,
                  privateKey: sshAuthMethod === "key" ? sshPrivateKey || undefined : undefined,
                  passphrase: sshAuthMethod === "key" ? sshPassphrase || undefined : undefined,
                  password: sshAuthMethod === "password" ? sshPassword || undefined : undefined,
                }
              : undefined,
          }),
    onSuccess: (config) => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      onConnected(config.id);
    },
  });

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="flex items-center gap-2">
        <Plug size={16} className="text-accent" />
        <span className="text-sm font-medium">New connection</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-6 gap-1 rounded-md bg-muted p-1 text-[10px]">
          {(Object.keys(DRIVER_LABELS) as DriverKey[]).map((d) => (
            <button
              key={d}
              onClick={() => selectDriver(d)}
              className={`rounded px-1 py-1 ${driver === d ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
            >
              {DRIVER_LABELS[d]}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Blocks INSERT/UPDATE/DELETE/DDL through this app, regardless of what the database credentials themselves allow.">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Read-only connection (block writes)
        </label>

        {driver === "sqlite" ? (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">File path</label>
            <Input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/path/to/database.sqlite" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1">
                <label className="text-xs text-muted-foreground">Host</label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Port</label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
            </div>
            {driver !== "redis" && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Database{driver === "mongodb" ? "" : ""}</label>
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
              </div>
            )}
            {driver === "redis" && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">DB index (optional, default 0)</label>
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="0" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {driver !== "redis" && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Username</label>
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
              )}
              <div className={driver === "redis" ? "col-span-2 space-y-1" : "space-y-1"}>
                <label className="text-xs text-muted-foreground">Password{driver === "redis" ? " (optional)" : ""}</label>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>

            <details className="rounded-md border border-input">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                TLS / client certificate
              </summary>
              <div className="space-y-2 border-t border-input p-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={sslEnabled} onChange={(e) => setSslEnabled(e.target.checked)} />
                  Use TLS
                </label>
                {sslEnabled && (
                  <>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={sslRejectUnauthorized}
                        onChange={(e) => setSslRejectUnauthorized(e.target.checked)}
                      />
                      Verify server certificate
                    </label>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">CA certificate (optional)</label>
                      <textarea
                        className={textareaClass}
                        rows={2}
                        value={sslCa}
                        onChange={(e) => setSslCa(e.target.value)}
                        placeholder="-----BEGIN CERTIFICATE-----"
                      />
                      <input
                        type="file"
                        className="text-xs text-muted-foreground"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) setSslCa(await readFileAsText(file));
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Client certificate (optional)</label>
                      <textarea
                        className={textareaClass}
                        rows={2}
                        value={sslCert}
                        onChange={(e) => setSslCert(e.target.value)}
                        placeholder="-----BEGIN CERTIFICATE-----"
                      />
                      <input
                        type="file"
                        className="text-xs text-muted-foreground"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) setSslCert(await readFileAsText(file));
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Client private key (optional)</label>
                      <textarea
                        className={textareaClass}
                        rows={2}
                        value={sslKey}
                        onChange={(e) => setSslKey(e.target.value)}
                        placeholder="-----BEGIN PRIVATE KEY-----"
                      />
                      <input
                        type="file"
                        className="text-xs text-muted-foreground"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) setSslKey(await readFileAsText(file));
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            </details>

            <details className="rounded-md border border-input">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                SSH tunnel (bastion)
              </summary>
              <div className="space-y-2 border-t border-input p-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} />
                  Connect through an SSH bastion
                </label>
                {sshEnabled && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2 space-y-1">
                        <label className="text-xs text-muted-foreground">Bastion host</label>
                        <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Port</label>
                        <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">SSH username</label>
                      <Input value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} placeholder="ec2-user" />
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground">
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          checked={sshAuthMethod === "key"}
                          onChange={() => setSshAuthMethod("key")}
                        />
                        Private key
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          checked={sshAuthMethod === "password"}
                          onChange={() => setSshAuthMethod("password")}
                        />
                        Password
                      </label>
                    </div>
                    {sshAuthMethod === "key" ? (
                      <>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">Private key (PEM or PPK)</label>
                          <textarea
                            className={textareaClass}
                            rows={3}
                            value={sshPrivateKey}
                            onChange={(e) => setSshPrivateKey(e.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          />
                          <input
                            type="file"
                            className="text-xs text-muted-foreground"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (file) setSshPrivateKey(await readFileAsText(file));
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground">Passphrase (optional)</label>
                          <Input type="password" value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} />
                        </div>
                      </>
                    ) : (
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">SSH password</label>
                        <Input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </details>
          </>
        )}

        {mutation.isError && <div className="text-xs text-destructive">{(mutation.error as Error).message}</div>}

        <Button className="w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Connecting…" : "Connect"}
        </Button>
      </CardContent>
    </Card>
  );
}
