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

export function ConnectionForm({ onConnected }: Props) {
  const [driver, setDriver] = useState<DriverKey>("sqlite");
  const [filePath, setFilePath] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(String(DEFAULT_PORTS.postgres));
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();

  function selectDriver(d: DriverKey) {
    setDriver(d);
    setPort(String(DEFAULT_PORTS[d]));
  }

  const mutation = useMutation({
    mutationFn: () =>
      driver === "sqlite"
        ? api.createConnection({ driver, filePath })
        : api.createConnection({
            driver,
            host,
            port: Number(port),
            database: database || undefined,
            username: username || undefined,
            password: password || undefined,
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
