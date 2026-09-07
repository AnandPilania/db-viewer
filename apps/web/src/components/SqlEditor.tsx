import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { TableDefinition } from "@pilaniaanand/driver-interface";

// Vite + monaco-editor recipe: bundle the editor's web workers locally
// instead of pulling them from a CDN, so this works fully offline. We only
// need the base editor worker — SQL is a "basic language" (syntax
// highlighting via a tokenizer, no language server) so it doesn't need its
// own dedicated worker the way TS/JSON/CSS do.
if (!window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  tables: TableDefinition[] | undefined;
  onRun?: () => void;
}

export function SqlEditor({ value, onChange, tables, onRun }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  // Same stale-closure hazard as tablesRef: the Ctrl+Enter action below is
  // registered once at mount, so without this it would permanently call
  // whichever `onRun` (and whatever `sql` state it closed over) existed on
  // the very first render — forever running the initial placeholder query
  // regardless of what's actually typed. The Run button doesn't have this
  // problem since it's a fresh click handler bound on every render.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  // Tracks the last value *we* emitted via onChange, so the effect below can
  // tell "value changed because the user typed" (skip — the editor already
  // has this content) from "value changed externally" (apply it). Without
  // this, every keystroke's own round-trip through parent state re-triggers
  // editor.setValue() on the next render, which resets the cursor to the
  // start and can clobber whatever the user typed in the meantime.
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    if (!containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language: "sql",
      theme: "vs-dark",
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: "on",
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = editor;

    const changeSub = editor.onDidChangeModelContent(() => {
      const v = editor.getValue();
      lastEmittedRef.current = v;
      onChange(v);
    });
    const runAction = editor.addAction({
      id: "run-query",
      label: "Run Query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current?.(),
    });

    // Schema-aware completion: suggests table names anywhere, and column
    // names for whichever table appears most recently before the cursor
    // (a lightweight heuristic — good enough for "SELECT * FROM users WHERE |").
    const completionProvider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: [".", " "],
      provideCompletionItems(model, position) {
        const currentTables = tablesRef.current ?? [];
        const textUntilCursor = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const tableSuggestions: monaco.languages.CompletionItem[] = currentTables.map((t) => ({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          detail: "table",
          range,
        }));

        const mentionedTable = [...currentTables]
          .reverse()
          .find((t) => new RegExp(`\\b${t.name}\\b`, "i").test(textUntilCursor));

        const columnSuggestions: monaco.languages.CompletionItem[] = (mentionedTable?.columns ?? []).map((c) => ({
          label: c.name,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: c.name,
          detail: `${mentionedTable!.name}.${c.name}: ${c.nativeType || c.type}`,
          range,
        }));

        const keywordSuggestions: monaco.languages.CompletionItem[] = [
          "SELECT",
          "FROM",
          "WHERE",
          "ORDER BY",
          "GROUP BY",
          "LIMIT",
          "JOIN",
          "LEFT JOIN",
          "INNER JOIN",
          "ON",
          "AND",
          "OR",
          "AS",
          "COUNT",
          "SUM",
          "AVG",
        ].map((kw) => ({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          range,
        }));

        return { suggestions: [...columnSuggestions, ...tableSuggestions, ...keywordSuggestions] };
      },
    });

    return () => {
      changeSub.dispose();
      runAction.dispose();
      completionProvider.dispose();
      editor.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the editor's content in sync if `value` changes externally (e.g. reset)
  // — but not if this `value` is just the echo of our own last onChange, or
  // typing would keep getting overwritten mid-edit (see lastEmittedRef above).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      editor.setValue(value);
    }
  }, [value]);

  return <div ref={containerRef} className="h-full w-full" />;
}
