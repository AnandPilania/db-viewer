import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { WidgetData } from "@/lib/api";

const COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#fb923c"];

interface Props {
  chartType: "bar" | "line" | "pie" | "number" | "table";
  data: WidgetData;
  title?: string;
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function ChartRenderer({ chartType, data }: Props) {
  if (chartType === "number") {
    const value = data.rows[0]?.[data.yKey];
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-3xl font-semibold tabular-nums">{toNumber(value).toLocaleString()}</div>
      </div>
    );
  }

  if (chartType === "table") {
    const cols = data.rows.length ? Object.keys(data.rows[0]) : [];
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              {cols.map((c) => (
                <th key={c} className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i} className="hover:bg-muted/40">
                {cols.map((c) => (
                  <td key={c} className="border-b border-border/40 px-2 py-1 font-mono">
                    {String(row[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const chartData = data.rows.map((r) => ({ x: String(r[data.xKey] ?? ""), y: toNumber(r[data.yKey]) }));

  if (chartType === "pie") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={chartData} dataKey="y" nameKey="x" cx="50%" cy="50%" outerRadius="75%" label>
            {chartData.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ background: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
          <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
          <YAxis tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
          <Tooltip contentStyle={{ background: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", fontSize: 12 }} />
          <Line type="monotone" dataKey="y" stroke="#38bdf8" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // bar (default)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 4% 20%)" />
        <XAxis dataKey="x" tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
        <YAxis tick={{ fontSize: 11 }} stroke="hsl(240 3% 65%)" />
        <Tooltip contentStyle={{ background: "hsl(240 5% 11%)", border: "1px solid hsl(240 4% 20%)", fontSize: 12 }} />
        <Bar dataKey="y" fill="#38bdf8" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
