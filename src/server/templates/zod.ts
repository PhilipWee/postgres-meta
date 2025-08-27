import prettier from 'prettier'
import type {
  PostgresColumn,
  PostgresFunction,
  PostgresSchema,
  PostgresTable,
  PostgresType,
  PostgresView,
} from '../../lib/index.js'
import type { GeneratorMetadata } from '../../lib/generators.js'
import { GENERATE_TYPES_DEFAULT_SCHEMA } from '../constants.js'

type ZodGenMode = 'list' | 'insert' | 'update'

export const apply = async ({
  schemas,
  tables,
  foreignTables,
  views,
  materializedViews,
  columns,
  types,
}: GeneratorMetadata): Promise<string> => {
  // Index columns by relation id
  const columnsByTableId = Object.fromEntries<PostgresColumn[]>(
    [...tables, ...foreignTables, ...views, ...materializedViews].map((t) => [t.id, []])
  )
  columns
    .filter((c) => c.table_id in columnsByTableId)
    .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    .forEach((c) => columnsByTableId[c.table_id].push(c))

  // Only emit for the default schema (matches your example)
  const defaultSchemaName = GENERATE_TYPES_DEFAULT_SCHEMA as string
  const defaultSchema =
    schemas.find((s) => s.name === defaultSchemaName) ??
    schemas[0] ??
    ({
      name: defaultSchemaName,
    } as PostgresSchema)

  const defaultSchemaTables = [...tables, ...foreignTables]
    .filter((t) => t.schema === defaultSchema.name)
    .sort(({ name: a }, { name: b }) => a.localeCompare(b))

  // Helpers to wrap nullable / optional
  const withNullable = (inner: string, isNullable: boolean) =>
    isNullable ? `${inner}.nullable()` : inner

  const makeListShapeLine = (col: PostgresColumn, ctx: PgTypeCtx) => {
    const base = pgTypeToZodSchema(defaultSchema, col.format, ctx, 'list')
    const z = withNullable(base, col.is_nullable)
    return `${JSON.stringify(col.name)}: ${z}`
  }

  const makeInsertShapeLine = (col: PostgresColumn, ctx: PgTypeCtx) => {
    // Optional when: nullable OR identity OR has default
    const isOptional = col.is_nullable || col.is_identity || col.default_value !== null

    // Identity ALWAYS -> forbid value if provided
    if (col.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(col.name)}?: z.never()`
    }

    let z = pgTypeToZodSchema(defaultSchema, col.format, ctx, 'insert')
    z = withNullable(z, col.is_nullable)
    if (isOptional) z += '.optional()'

    return `${JSON.stringify(col.name)}: ${z}`
  }

  const makeUpdateShapeLine = (col: PostgresColumn, ctx: PgTypeCtx) => {
    // Update: everything optional; identity ALWAYS -> forbid value if provided
    if (col.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(col.name)}?: z.never()`
    }
    let z = pgTypeToZodSchema(defaultSchema, col.format, ctx, 'update')
    z = withNullable(z, col.is_nullable)
    z += '.optional()'
    return `${JSON.stringify(col.name)}: ${z}`
  }

  // Build the file as a string
  let out = `
/* START GENERATED TYPES */
import { z } from "zod";

export const supabaseZodSchemas = {
  ${defaultSchemaTables
    .map((table) => {
      const ctx: PgTypeCtx = { types, schemas, tables, views }
      const cols = columnsByTableId[table.id] ?? []

      const listShape = cols.map((c) => makeListShapeLine(c, ctx)).join(',\n      ')
      const insertShape = cols.map((c) => makeInsertShapeLine(c, ctx)).join(',\n      ')
      const updateShape = cols.map((c) => makeUpdateShapeLine(c, ctx)).join(',\n      ')

      return `${JSON.stringify(table.name)}: {
    list: z.object({
      ${listShape}
    }),
    insert: z.object({
      ${insertShape}
    }),
    update: z.object({
      ${updateShape}
    }),
  }`
    })
    .join(',\n  ')}
} as const
`

  // Format nicely
  out = await prettier.format(out, { parser: 'typescript', semi: false })
  return out
}

type PgTypeCtx = {
  types: PostgresType[]
  schemas: PostgresSchema[]
  tables: PostgresTable[]
  views: PostgresView[]
}

const pgTypeToZodSchema = (
  schema: PostgresSchema,
  pgType: string,
  {
    types,
    schemas,
    tables, // kept for signature compatibility
    views,  // kept for signature compatibility
  }: PgTypeCtx,
  mode: ZodGenMode // <-- new
): string => {
  const numberTypes = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'])

  // Treat time-only as strings; date/timestamp handled below
  const stringTypes = new Set([
    'bytea',
    'bpchar',
    'varchar',
    'text',
    'citext',
    'time',
    'timetz',
    'vector',
  ])

  const dateLikeTypes = new Set(['date', 'timestamp', 'timestamptz'])

  const getEnumVariants = (t: string): string[] | null => {
    const enumTypes = types.filter((type) => type.name === t && type.enums.length > 0)
    if (enumTypes.length === 0) return null
    const preferred = enumTypes.find((t_) => t_.schema === schema.name) || enumTypes[0]
    // Inline variants regardless of whether the enum's schema is in `schemas`
    return preferred.enums.map((v) => JSON.stringify(v))
  }

  // Arrays: leading underscore means array of the inner type
  if (pgType.startsWith('_')) {
    return `z.array(${pgTypeToZodSchema(schema, pgType.slice(1), {
      types,
      schemas,
      tables,
      views,
    }, mode)})`
  }

  // Enums inline
  {
    const enumVariants = getEnumVariants(pgType)
    if (enumVariants) return `z.enum([${enumVariants.join(', ')}])`
  }

  // Scalars
  if (pgType === 'bool') return 'z.boolean()'
  if (numberTypes.has(pgType)) return 'z.number()'

  // Date-like handling differs by mode:
  if (dateLikeTypes.has(pgType)) {
    if (mode === 'list') {
      // Read shapes coerce to Date
      return 'z.coerce.date()'
    } else {
      // Write shapes: only Date in, string out (ISO)
      return 'z.instanceof(Date).transform(d => d.toISOString())'
    }
  }

  // UUID with format validation
  if (pgType === 'uuid') return 'z.string().uuid()' // (avoid z.uuid(); ensure zod compatibility)

  if (stringTypes.has(pgType)) return 'z.string()'
  if (pgType === 'json' || pgType === 'jsonb') return 'z.any()'
  if (pgType === 'void') return 'z.undefined()'
  if (pgType === 'record') return 'z.record(z.unknown())'

  // Everything else:
  // - composite types
  // - table row types
  // - view row types
  // - ranges (still TBD)
  // - unknowns
  return 'z.unknown()'
}
