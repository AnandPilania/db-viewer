import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plug } from "lucide-react";
import type { ConnectionConfig } from "@pilaniaanand/driver-interface";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface Props {
    onConnected: (connectionId: string) => void;
    /** When set, the form edits this connection in place instead of creating a new one. */
    editing?: ConnectionConfig;
    /** Shows a back arrow at the top-left of the card when provided. */
    onBack?: () => void;
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

export function ConnectionForm({ onConnected, editing, onBack }: Props) {
    const [driver, setDriver] = useState<DriverKey>((editing?.driver as DriverKey) ?? "sqlite");
    const [filePath, setFilePath] = useState(editing?.filePath ?? "");
    const [host, setHost] = useState(editing?.host ?? "localhost");
    const [port, setPort] = useState(String(editing?.port ?? DEFAULT_PORTS.postgres));
    const [database, setDatabase] = useState(editing?.database ?? "");
    const [username, setUsername] = useState(editing?.username ?? "");
    // Left blank on edit — submitting blank means "keep the existing password".
    const [password, setPassword] = useState("");
    const [readOnly, setReadOnly] = useState(editing?.readOnly ?? false);
    const [allowMultiDbDashboards, setAllowMultiDbDashboards] = useState(editing?.allowMultiDbDashboards ?? false);
    const [installCdc, setInstallCdc] = useState(editing?.installCdc ?? false);

    // TLS client-cert auth — for a database that requires (or accepts) certificate-based auth directly.
    // Editing an existing connection's TLS/SSH secrets isn't supported here (they come back redacted, never
    // in plaintext) — leaving a section untouched keeps whatever is already saved; re-enter values to replace them.
    const [sslEnabled, setSslEnabled] = useState(!!editing?.ssl);
    const [sslTouched, setSslTouched] = useState(false);
    const [sslRejectUnauthorized, setSslRejectUnauthorized] = useState(true);
    const [sslCa, setSslCa] = useState("");
    const [sslCert, setSslCert] = useState("");
    const [sslKey, setSslKey] = useState("");

    // SSH tunnel — for a database reachable only through a bastion/jump host (e.g. AWS RDS in a private subnet).
    const [sshEnabled, setSshEnabled] = useState(!!editing?.sshTunnel?.enabled);
    const [sshTouched, setSshTouched] = useState(false);
    const [sshHost, setSshHost] = useState(editing?.sshTunnel?.host ?? "");
    const [sshPort, setSshPort] = useState(String(editing?.sshTunnel?.port ?? 22));
    const [sshUsername, setSshUsername] = useState(editing?.sshTunnel?.username ?? "");
    const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("key");
    const [sshPrivateKey, setSshPrivateKey] = useState("");
    const [sshPassphrase, setSshPassphrase] = useState("");
    const [sshPassword, setSshPassword] = useState("");

    const queryClient = useQueryClient();

    function selectDriver(d: DriverKey) {
        setDriver(d);
        setPort(String(DEFAULT_PORTS[d]));
    }

    // On edit, an untouched TLS/SSH section is left out of the patch entirely so the
    // saved secrets aren't overwritten by the redacted/blank values sitting in the form.
    const includeSsl = !editing || sslTouched;
    const includeSsh = !editing || sshTouched;

    function buildBody() {
        return driver === "sqlite"
            ? {
                  driver,
                  filePath,
                  readOnly: readOnly || undefined,
                  allowMultiDbDashboards: allowMultiDbDashboards || undefined,
              }
            : {
                  driver,
                  host,
                  port: Number(port),
                  database: database || undefined,
                  username: username || undefined,
                  password: password || undefined,
                  readOnly: readOnly || undefined,
                  installCdc: installCdc || undefined,
                  ssl: !includeSsl
                      ? undefined
                      : sslEnabled
                        ? {
                              enabled: true,
                              rejectUnauthorized: sslRejectUnauthorized,
                              ca: sslCa || undefined,
                              cert: sslCert || undefined,
                              key: sslKey || undefined,
                          }
                        : false,
                  sshTunnel: !includeSsh
                      ? undefined
                      : {
                            enabled: sshEnabled,
                            host: sshHost,
                            port: Number(sshPort) || 22,
                            username: sshUsername,
                            privateKey: sshAuthMethod === "key" ? sshPrivateKey || undefined : undefined,
                            passphrase: sshAuthMethod === "key" ? sshPassphrase || undefined : undefined,
                            password: sshAuthMethod === "password" ? sshPassword || undefined : undefined,
                        },
                  allowMultiDbDashboards: allowMultiDbDashboards || undefined,
              };
    }

    const mutation = useMutation({
        mutationFn: () => {
            const body = buildBody();
            return editing
                ? api.updateConnection(editing.id, body)
                : api.createConnection(body as Omit<ConnectionConfig, "id">);
        },
        onSuccess: (config) => {
            queryClient.invalidateQueries({ queryKey: ["connections"] });
            onConnected(config.id);
        },
    });

    const testMutation = useMutation({
        mutationFn: () => {
            const body = buildBody();
            return editing
                ? api.testExistingConnection(editing.id, body)
                : api.testNewConnection(body as Omit<ConnectionConfig, "id">);
        },
    });

    return (
        <Card className="w-full max-w-lg">
            <CardHeader className="flex items-center gap-2">
                {onBack && (
                    <button
                        onClick={onBack}
                        aria-label="Back"
                        className="-ml-1 rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                        <ArrowLeft size={14} />
                    </button>
                )}
                <Plug size={16} className="text-accent" />
                <span className="text-sm font-medium">{editing ? "Edit connection" : "New connection"}</span>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="grid grid-cols-6 gap-1 rounded-md bg-muted p-1 text-[10px]">
                    {(Object.keys(DRIVER_LABELS) as DriverKey[]).map((d) => (
                        <button
                            key={d}
                            disabled={!!editing}
                            onClick={() => selectDriver(d)}
                            className={`rounded px-1 py-1 ${driver === d ? "bg-accent text-accent-foreground" : "text-muted-foreground"} ${editing ? "cursor-not-allowed opacity-60" : ""}`}
                        >
                            {DRIVER_LABELS[d]}
                        </button>
                    ))}
                </div>

                <div className="grid grid-cols-2 grid-cols-sm-1">
                    <label
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        title="Blocks INSERT/UPDATE/DELETE/DDL through this app, regardless of what the database credentials themselves allow."
                    >
                        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                        Read-only connection (block writes)
                    </label>

                    <label
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        title="Lets this connection's widgets sit on a dashboard together with widgets from other connections that also opt in. An embedded dashboard's share link grants read access to every connection its widgets touch, so leave this off for anything that shouldn't be exposed alongside another database."
                    >
                        <input
                            type="checkbox"
                            checked={allowMultiDbDashboards}
                            onChange={(e) => setAllowMultiDbDashboards(e.target.checked)}
                        />
                        Allow on multi-database dashboards
                    </label>
                </div>

                {/* Only Postgres and Redis have a CDC path that writes to the target
            server; every other driver detects changes read-only already. */}
                {(driver === "postgres" || driver === "redis") && !readOnly && (
                    <label
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                        title={
                            driver === "postgres"
                                ? "Creates a trigger and function on each table you watch, and drops them on disconnect. Needs DDL rights and, in a regulated environment, change-control approval. Left off, changes are detected by polling instead."
                                : "Runs CONFIG SET notify-keyspace-events on the server, which affects every client of that instance. Left off, we subscribe to whatever the server already emits."
                        }
                    >
                        <input type="checkbox" checked={installCdc} onChange={(e) => setInstallCdc(e.target.checked)} />
                        <span>
                            Allow live-updates setup on the server
                            <span className="block text-[10px] opacity-70">
                                {driver === "postgres"
                                    ? "Installs a trigger per watched table"
                                    : "Changes a server-wide Redis setting"}
                            </span>
                        </span>
                    </label>
                )}

                {driver === "sqlite" ? (
                    <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">File path</label>
                        <Input
                            value={filePath}
                            onChange={(e) => setFilePath(e.target.value)}
                            placeholder="/path/to/database.sqlite"
                        />
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
                                <label className="text-xs text-muted-foreground">
                                    Database{driver === "mongodb" ? "" : ""}
                                </label>
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
                                <label className="text-xs text-muted-foreground">
                                    Password
                                    {!editing && driver === "redis" && " (optional)"}
                                </label>
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="placeholder:text-xs placeholder:text-muted-foreground/70"
                                    placeholder={editing ? "Leave blank to keep the current one" : ""}
                                />
                            </div>
                        </div>

                        <details className="rounded-md border border-input">
                            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
                                TLS / client certificate
                            </summary>
                            <div
                                className="space-y-2 border-t border-input p-3"
                                onChangeCapture={() => setSslTouched(true)}
                            >
                                {editing && !sslTouched && (
                                    <div className="text-[10px] text-muted-foreground">
                                        {sslEnabled
                                            ? "TLS is configured. Change any field below to replace it."
                                            : "TLS is off."}
                                    </div>
                                )}
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={sslEnabled}
                                        onChange={(e) => setSslEnabled(e.target.checked)}
                                    />
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
                                            <label className="text-xs text-muted-foreground">
                                                CA certificate (optional)
                                            </label>
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
                                            <label className="text-xs text-muted-foreground">
                                                Client certificate (optional)
                                            </label>
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
                                            <label className="text-xs text-muted-foreground">
                                                Client private key (optional)
                                            </label>
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
                            <div
                                className="space-y-2 border-t border-input p-3"
                                onChangeCapture={() => setSshTouched(true)}
                            >
                                {editing && !sshTouched && (
                                    <div className="text-[10px] text-muted-foreground">
                                        {sshEnabled
                                            ? "An SSH tunnel is configured. Change any field below to replace it."
                                            : "SSH tunnel is off."}
                                    </div>
                                )}
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={sshEnabled}
                                        onChange={(e) => setSshEnabled(e.target.checked)}
                                    />
                                    Connect through an SSH bastion
                                </label>
                                {sshEnabled && (
                                    <>
                                        <div className="grid grid-cols-3 gap-2">
                                            <div className="col-span-2 space-y-1">
                                                <label className="text-xs text-muted-foreground">Bastion host</label>
                                                <Input
                                                    value={sshHost}
                                                    onChange={(e) => setSshHost(e.target.value)}
                                                    placeholder="bastion.example.com"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-xs text-muted-foreground">Port</label>
                                                <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
                                            </div>
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">SSH username</label>
                                            <Input
                                                value={sshUsername}
                                                onChange={(e) => setSshUsername(e.target.value)}
                                                placeholder="ec2-user"
                                            />
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
                                                    <label className="text-xs text-muted-foreground">
                                                        Private key (PEM or PPK)
                                                    </label>
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
                                                    <label className="text-xs text-muted-foreground">
                                                        Passphrase (optional)
                                                    </label>
                                                    <Input
                                                        type="password"
                                                        value={sshPassphrase}
                                                        onChange={(e) => setSshPassphrase(e.target.value)}
                                                    />
                                                </div>
                                            </>
                                        ) : (
                                            <div className="space-y-1">
                                                <label className="text-xs text-muted-foreground">SSH password</label>
                                                <Input
                                                    type="password"
                                                    value={sshPassword}
                                                    onChange={(e) => setSshPassword(e.target.value)}
                                                />
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </details>
                    </>
                )}

                {testMutation.isSuccess && (
                    <div className={`text-xs ${testMutation.data.ok ? "text-emerald-500" : "text-destructive"}`}>
                        {testMutation.data.ok
                            ? "Connection successful."
                            : (testMutation.data.message ?? "Connection failed.")}
                    </div>
                )}
                {testMutation.isError && (
                    <div className="text-xs text-destructive">{(testMutation.error as Error).message}</div>
                )}
                {mutation.isError && (
                    <div className="text-xs text-destructive">{(mutation.error as Error).message}</div>
                )}

                <div className="flex gap-2">
                    {onBack && (
                        <Button variant="ghost" className="flex-1" onClick={onBack}>
                            Cancel
                        </Button>
                    )}
                    <Button
                        variant="secondary"
                        className="flex-1"
                        onClick={() => testMutation.mutate()}
                        disabled={testMutation.isPending}
                    >
                        {testMutation.isPending ? "Testing…" : "Test connection"}
                    </Button>
                    <Button className="flex-1" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                        {mutation.isPending ? "Saving…" : editing ? "Save changes" : "Connect"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
