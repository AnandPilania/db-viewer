import { forwardRef, useImperativeHandle, useState } from "react";
import type { QuerySpec, TableDefinition } from "@db-viewer/driver-interface";

export interface QueryEditorHandle {
  run(): void;
}

interface Props {
  collections: TableDefinition[] | undefined;
  onRun: (query: QuerySpec) => void;
  disabled?: boolean;
}

/**
 * MongoDB has no SQL — this builds a typed { language: "mongo", ... }
 * QuerySpec from form fields instead of pretending a text box full of JS
 * object syntax is "SQL". A collection name plus either a filter or a full
 * aggregation pipeline covers the same ground the old JSON-in-a-string hack
 * did, but every field here is real, typed input instead of a blob the
 * driver had to JSON.parse and hope was well-formed.
 *
 * Exposes `run()` via ref so the shared Run/Cancel button in QueryEditor
 * can trigger this editor's build-and-submit without QueryEditor needing
 * to know about mongo's filter/sort/limit/pipeline fields itself.
 */
export const MongoQueryEditor = forwardRef<QueryEditorHandle, Props>(function MongoQueryEditor(
  { collections, onRun, disabled },
  ref
) {
  const [collection, setCollection] = useState("");
  const [mode, setMode] = useState<"find" | "aggregate">("find");
  const [filterText, setFilterText] = useState("{}");
  const [sortText, setSortText] = useState("");
  const [limitText, setLimitText] = useState("1000");
  const [pipelineText, setPipelineText] = useState("[]");
  const [parseError, setParseError] = useState<string | null>(null);

  function handleRun() {
    if (!collection.trim()) {
      setParseError("Collection name is required");
      return;
    }
    try {
      if (mode === "aggregate") {
        const pipeline = JSON.parse(pipelineText || "[]");
        if (!Array.isArray(pipeline)) throw new Error("Pipeline must be a JSON array");
        setParseError(null);
        onRun({ language: "mongo", collection, pipeline });
        return;
      }
      const filter = JSON.parse(filterText || "{}");
      const sort = sortText.trim() ? JSON.parse(sortText) : undefined;
      const limit = limitText.trim() ? Number(limitText) : undefined;
      setParseError(null);
      onRun({ language: "mongo", collection, filter, sort, limit });
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  useImperativeHandle(ref, () => ({ run: handleRun }));

  return (
    <div className="flex h-28 flex-1 flex-col gap-1.5 overflow-y-auto rounded-md border border-input p-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          list="mongo-collections"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder="collection"
          disabled={disabled}
          className="w-40 rounded border border-input bg-background px-2 py-1 font-mono"
        />
        <datalist id="mongo-collections">
          {(collections ?? []).map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
        <div className="flex overflow-hidden rounded border border-input">
          <button
            type="button"
            onClick={() => setMode("find")}
            className={`px-2 py-1 ${mode === "find" ? "bg-accent" : ""}`}
          >
            find
          </button>
          <button
            type="button"
            onClick={() => setMode("aggregate")}
            className={`px-2 py-1 ${mode === "aggregate" ? "bg-accent" : ""}`}
          >
            aggregate
          </button>
        </div>
        {parseError && <span className="text-destructive">{parseError}</span>}
      </div>

      {mode === "find" ? (
        <div className="flex flex-1 gap-1.5">
          <textarea
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="filter: {}"
            disabled={disabled}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleRun();
            }}
            className="h-full flex-1 resize-none rounded border border-input bg-background p-1.5 font-mono"
          />
          <textarea
            value={sortText}
            onChange={(e) => setSortText(e.target.value)}
            placeholder='sort: { "_id": 1 }'
            disabled={disabled}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleRun();
            }}
            className="h-full flex-1 resize-none rounded border border-input bg-background p-1.5 font-mono"
          />
          <input
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
            placeholder="limit"
            disabled={disabled}
            className="h-7 w-20 self-start rounded border border-input bg-background px-2 py-1 font-mono"
          />
        </div>
      ) : (
        <textarea
          value={pipelineText}
          onChange={(e) => setPipelineText(e.target.value)}
          placeholder='[{ "$match": {} }, { "$group": {...} }]'
          disabled={disabled}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleRun();
          }}
          className="h-full flex-1 resize-none rounded border border-input bg-background p-1.5 font-mono"
        />
      )}
    </div>
  );
});
