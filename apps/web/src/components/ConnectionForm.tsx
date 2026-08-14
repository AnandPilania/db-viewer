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

export function ConnectionForm({ onConnected }: Props) {
  const [driver, setDriver] = useState<"sqlite" | "postgres" | "mysql" | "mongodb">("sqlite");
  const [filePath, setFilePath] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      driver === "sqlite"
        ? api.createConnection({ driver, filePath })
        : api.createConnection({ driver, host, port: Number(port), database, username, password }),
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
        <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
          {(["sqlite", "postgres", "mysql", "mongodb"] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDriver(d)}
              className={`flex-1 rounded px-2 py-1 ${driver === d ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
            >
              {d}
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
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Database</label>
              <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Username</label>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Password</label>
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
