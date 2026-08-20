import { useState } from "react";
import type { ColumnDefinition } from "@pilaniaanand/driver-interface";
import { validateValue, placeholderFor } from "@/lib/validation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";

interface Props {
  table: string;
  columns: ColumnDefinition[];
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function NewRowDialog({ table, columns, onCancel, onSubmit }: Props) {
  const editableColumns = columns.filter((c) => !(c.isPrimaryKey && c.defaultValue));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const values: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};

    for (const col of editableColumns) {
      const raw = drafts[col.name] ?? "";
      const result = validateValue(raw, col);
      if (!result.valid) {
        nextErrors[col.name] = result.error!;
        continue;
      }
      if (result.value !== undefined) values[col.name] = result.value;
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    setSubmitError(null);
    const result = await onSubmit(values);
    setSaving(false);
    if (!result.ok) setSubmitError(result.error);
  }

  return (
    <Modal onClose={onCancel} labelledBy="new-row-title">
      <Card className="w-full max-w-md">
        <CardHeader>
          <span id="new-row-title" className="text-sm font-medium">
            New row in {table}
          </span>
        </CardHeader>
        <CardContent className="max-h-[70vh] space-y-3 overflow-y-auto">
          {editableColumns.map((col) => (
            <div key={col.name} className="space-y-1">
              <label htmlFor={`new-row-${col.name}`} className="flex items-center gap-1 text-xs text-muted-foreground">
                {col.name}
                <span className="text-[10px] text-muted-foreground/60">
                  {col.nativeType || col.type}
                  {!col.nullable && !col.defaultValue && " · required"}
                </span>
              </label>
              <Input
                id={`new-row-${col.name}`}
                value={drafts[col.name] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [col.name]: e.target.value }))}
                placeholder={placeholderFor(col)}
                aria-invalid={!!errors[col.name]}
                aria-describedby={errors[col.name] ? `new-row-${col.name}-error` : undefined}
                className={errors[col.name] ? "border-destructive" : undefined}
              />
              {errors[col.name] && (
                <div id={`new-row-${col.name}-error`} className="text-[11px] text-destructive">
                  {errors[col.name]}
                </div>
              )}
            </div>
          ))}

          {submitError && (
            <div role="alert" className="text-xs text-destructive">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={saving}>
              {saving ? "Creating…" : "Create row"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </Modal>
  );
}
