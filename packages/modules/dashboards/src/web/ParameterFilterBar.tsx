import { Input } from "./ui.js";
import type { DashboardParameter } from "./api.js";

interface Props {
    parameters: DashboardParameter[];
    values: Record<string, unknown>;
    onChange: (name: string, value: unknown) => void;
}

/**
 * The dashboard-level filter bar — one control per declared parameter.
 * Shared between the in-app DashboardBuilder and the public EmbedDashboard
 * (Part C), so both render identically instead of maintaining two copies of
 * this JSX.
 */
export function ParameterFilterBar({ parameters, values, onChange }: Props) {
    if (parameters.length === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/30 px-3 py-2">
            {parameters.map((p) => (
                <div key={p.name} className="flex items-center gap-1.5">
                    <label className="text-xs text-muted-foreground">{p.label}</label>
                    {p.type === "select" ? (
                        <select
                            value={String(values[p.name] ?? "")}
                            onChange={(e) => onChange(p.name, e.target.value)}
                            className="h-8 rounded-md border border-input bg-card px-2 text-sm"
                        >
                            <option value="">All</option>
                            {(p.options ?? []).map((o) => (
                                <option key={o} value={o}>
                                    {o}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <Input
                            type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                            value={String(values[p.name] ?? "")}
                            onChange={(e) => onChange(p.name, e.target.value)}
                            className="h-8 w-40"
                        />
                    )}
                </div>
            ))}
        </div>
    );
}
