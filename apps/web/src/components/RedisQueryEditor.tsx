import { forwardRef, useImperativeHandle, useState } from "react";
import type { QuerySpec, RedisKeyType } from "@pilaniaanand/driver-interface";
import type { QueryEditorHandle } from "@/components/MongoQueryEditor";

const KEY_TYPES: RedisKeyType[] = ["string", "hash", "list", "set", "zset", "stream"];

interface Props {
  onRun: (query: QuerySpec) => void;
  disabled?: boolean;
}

/**
 * Redis has no query language — browsing is just a SCAN over one key type
 * with an optional glob pattern. This builds the typed
 * { language: "redis-command", type, pattern, limit } read QuerySpec
 * directly from three fields; no JSON, no command array, since a browse
 * isn't really "a command" the way a write is.
 */
export const RedisQueryEditor = forwardRef<QueryEditorHandle, Props>(function RedisQueryEditor(
  { onRun, disabled },
  ref
) {
  const [type, setType] = useState<RedisKeyType>("string");
  const [pattern, setPattern] = useState("*");
  const [limitText, setLimitText] = useState("1000");

  function handleRun() {
    const limit = limitText.trim() ? Number(limitText) : undefined;
    onRun({ language: "redis-command", type, pattern: pattern || "*", limit });
  }

  useImperativeHandle(ref, () => ({ run: handleRun }));

  return (
    <div className="flex h-28 flex-1 items-start gap-2 rounded-md border border-input p-2 text-xs">
      <select
        value={type}
        onChange={(e) => setType(e.target.value as RedisKeyType)}
        disabled={disabled}
        className="rounded border border-input bg-background px-2 py-1 font-mono"
      >
        {KEY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        placeholder="pattern, e.g. user:*"
        disabled={disabled}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleRun();
        }}
        className="flex-1 rounded border border-input bg-background px-2 py-1 font-mono"
      />
      <input
        value={limitText}
        onChange={(e) => setLimitText(e.target.value)}
        placeholder="limit"
        disabled={disabled}
        className="w-24 rounded border border-input bg-background px-2 py-1 font-mono"
      />
      <span className="mt-1 text-muted-foreground">
        Browses keys of one type via SCAN. For writes (SET, DEL, ...), use the Execute panel.
      </span>
    </div>
  );
});
