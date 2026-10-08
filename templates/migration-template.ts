import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Operations like pgm.createTable() and pgm.sql() queue SQL statements.
// The runner executes them after up or down completes; awaiting a builder
// operation does not execute its queued SQL. pgm.db.query() executes directly.

export async function up(pgm: MigrationBuilder): Promise<void> {}

export async function down(pgm: MigrationBuilder): Promise<void> {}
