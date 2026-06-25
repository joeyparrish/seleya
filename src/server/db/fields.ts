import type Database from "better-sqlite3";

export interface IssueTypeDef {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}

export interface FieldOptionDef {
  id: string;
  name: string;
  color: string | null;
  position: number | null;
}

export type FieldDataType = "single_select" | "multi_select" | "number" | "text" | "date";

export interface FieldDef {
  id: string;
  repoId: string;
  name: string;
  dataType: FieldDataType;
  options: FieldOptionDef[];
}

export interface IssueFieldValue {
  fieldName: string;
  dataType: FieldDataType;
  valueText?: string | null;
  valueNumber?: number | null;
  valueDate?: string | null;
  optionId?: string | null;
}

export function upsertIssueType(db: Database.Database, t: IssueTypeDef): void {
  db.prepare(
    `INSERT INTO issue_types (id, name, color, description)
     VALUES (@id, @name, @color, @description)
     ON CONFLICT(id) DO UPDATE SET name=@name, color=@color, description=@description`,
  ).run(t);
}

export function upsertFieldDefinition(db: Database.Database, f: FieldDef): void {
  const tx = db.transaction((def: FieldDef) => {
    db.prepare(
      `INSERT INTO field_definitions (id, repo_id, name, data_type)
       VALUES (@id, @repo_id, @name, @data_type)
       ON CONFLICT(id) DO UPDATE SET repo_id=@repo_id, name=@name, data_type=@data_type`,
    ).run({ id: def.id, repo_id: def.repoId, name: def.name, data_type: def.dataType });

    db.prepare("DELETE FROM field_options WHERE field_definition_id=?").run(def.id);
    const ins = db.prepare(
      `INSERT INTO field_options (id, field_definition_id, name, color, position)
       VALUES (@id, @field_definition_id, @name, @color, @position)`,
    );
    for (const o of def.options) {
      ins.run({
        id: o.id,
        field_definition_id: def.id,
        name: o.name,
        color: o.color,
        position: o.position,
      });
    }
  });
  tx(f);
}

export function setIssueFieldValues(
  db: Database.Database,
  issueId: string,
  values: IssueFieldValue[],
): void {
  const tx = db.transaction((vals: IssueFieldValue[]) => {
    db.prepare("DELETE FROM issue_field_values WHERE issue_id=?").run(issueId);
    const ins = db.prepare(
      `INSERT INTO issue_field_values
         (issue_id, field_name, data_type, value_text, value_number, value_date, option_id)
       VALUES (@issue_id, @field_name, @data_type, @value_text, @value_number, @value_date, @option_id)`,
    );
    for (const v of vals) {
      ins.run({
        issue_id: issueId,
        field_name: v.fieldName,
        data_type: v.dataType,
        value_text: v.valueText ?? null,
        value_number: v.valueNumber ?? null,
        value_date: v.valueDate ?? null,
        option_id: v.optionId ?? null,
      });
    }
  });
  tx(values);
}

export function getFieldValues(db: Database.Database, issueId: string): IssueFieldValue[] {
  const rows = db
    .prepare("SELECT * FROM issue_field_values WHERE issue_id=?")
    .all(issueId) as Array<{
    field_name: string;
    data_type: FieldDataType;
    value_text: string | null;
    value_number: number | null;
    value_date: string | null;
    option_id: string | null;
  }>;
  return rows.map((r) => ({
    fieldName: r.field_name,
    dataType: r.data_type,
    valueText: r.value_text,
    valueNumber: r.value_number,
    valueDate: r.value_date,
    optionId: r.option_id,
  }));
}

export function listFieldDefinitions(db: Database.Database): FieldDef[] {
  const defs = db
    .prepare("SELECT id, repo_id, name, data_type FROM field_definitions ORDER BY name")
    .all() as Array<{ id: string; repo_id: string; name: string; data_type: FieldDataType }>;
  const optStmt = db.prepare(
    "SELECT id, name, color, position FROM field_options WHERE field_definition_id=? ORDER BY position, name",
  );
  return defs.map((d) => ({
    id: d.id,
    repoId: d.repo_id,
    name: d.name,
    dataType: d.data_type,
    options: optStmt.all(d.id) as FieldOptionDef[],
  }));
}
